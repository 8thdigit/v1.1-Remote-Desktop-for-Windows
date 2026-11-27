import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Subscription and license management for the relay. Every company account
// (one RA ID) can hold a subscription to a plan. A company's PCs only work
// while that subscription is active and within its session quota; the relay
// enforces this at registration, so an expired or over-quota company cannot
// start sessions even with a patched client. Payments, upcoming dues and a
// session history are tracked per company so the operator can bill and audit.
//
// This module is deliberately independent of the accounts module: it keys
// everything by the account id (a company) and never needs the password
// material. The route layer maps an RA ID to an account id when it enforces.

export type BillingInterval = "monthly" | "quarterly" | "annual";

export const INTERVALS: BillingInterval[] = ["monthly", "quarterly", "annual"];

// How many days each interval covers, used to roll a subscription period and
// to schedule the next due date.
export const INTERVAL_DAYS: Record<BillingInterval, number> = {
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

export const DAY = 24 * 60 * 60_000;

// A subscription plan (tier). Prices are whole Indian rupees (INR). A quota
// of 0 means unlimited. maxConcurrentViewers and maxSessionMinutes of 0 mean
// "use the relay default".
export type Plan = {
  id: string;
  name: string;
  description: string;
  priceInr: number;
  interval: BillingInterval;
  sessionQuota: number;
  maxConcurrentViewers: number;
  maxSessionMinutes: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

// The stored status an operator sets. The *effective* status also accounts
// for the period having lapsed (see effectiveStatus).
export type SubStatus = "active" | "suspended" | "expired" | "trial";

// One subscription per company account.
export type Subscription = {
  accountId: string;
  planId: string | null;
  status: SubStatus;
  startedAt: number;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  // Usage counted in the current period; reset when the period rolls. It is
  // the sum of urlsUsed and extraSessionsUsed (plus any usage counted before
  // the breakdown existed).
  sessionsUsed: number;
  // Remote access URLs the company authorized with its Access PIN this period.
  urlsUsed: number;
  // Sessions started while another of the company's sessions was already live.
  extraSessionsUsed: number;
  // Extra usage an operator granted on top of the plan quota for this period.
  graceSessions: number;
  // Every grace extension ever granted, newest first.
  graceLog: GraceExtension[];
  // Bumped to revoke every license issued before (a company that was
  // compromised, or a client that must be re-provisioned).
  licenseVersion: number;
  autoRenew: boolean;
  // When set, the company's PCs must present a valid, current license to
  // register. This blocks a cracked or copied client that drops the license,
  // and enforces revocation. Off by default so legacy PCs keep working until
  // the operator provisions licensed clients.
  requireLicense: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
};

export type GraceExtension = {
  id: string;
  amount: number;
  remarks: string;
  by: string;
  at: number;
  // The end of the period the extension applied to.
  periodEnd: number;
};

export type UsageKind = "url" | "session";

const MAX_GRACE_LOG = 100;

export type PaymentStatus = "paid" | "due" | "overdue";

export type Payment = {
  id: string;
  accountId: string;
  amountInr: number;
  interval: BillingInterval | null;
  periodStart: number | null;
  periodEnd: number | null;
  dueDate: number;
  status: PaymentStatus;
  paidAt: number | null;
  method: string;
  reference: string;
  note: string;
  createdAt: number;
};

// One completed (or ended) remote session, for history and quota auditing.
export type SessionRecord = {
  id: string;
  // The live session's internal id, which links AI Buddy's record to it.
  sessionId?: string;
  accountId: string | null;
  raId: string;
  pcName: string;
  mode: "attended" | "unattended" | "link";
  operator: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  viewers: number;
};

type BillingData = {
  plans: Plan[];
  subscriptions: Subscription[];
  payments: Payment[];
  history: SessionRecord[];
  secret?: string;
};

export type BillingBackend = {
  load(): Promise<BillingData | undefined>;
  save(data: BillingData): Promise<void>;
  describe: string;
};

const MAX_HISTORY = 2000;
const MAX_PAYMENTS = 5000;

export class BillingError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- Backends (file / Postgres / memory), mirroring the accounts store. ---

export function fileBillingBackend(dir: string): BillingBackend {
  const file = path.join(dir, "billing.json");
  return {
    describe: file,
    async load() {
      try {
        return JSON.parse(await readFile(file, "utf8")) as BillingData;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    async save(data) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

// Stored as one row in the same msfwr_state table the accounts use, under a
// different id, so no separate migration is needed.
export async function postgresBillingBackend(url: string): Promise<BillingBackend> {
  const { createPgPool, withPgFallback } = await import("./pgpool");
  const pool = await createPgPool(url);
  await pool.query("CREATE TABLE IF NOT EXISTS msfwr_state (id text PRIMARY KEY, data jsonb NOT NULL)");
  const pgStore: BillingBackend = {
    describe: "PostgreSQL (DATABASE_URL)",
    async load() {
      const r = await pool.query("SELECT data FROM msfwr_state WHERE id = 'billing'");
      return r.rows[0]?.data as BillingData | undefined;
    },
    async save(data) {
      await pool.query(
        "INSERT INTO msfwr_state (id, data) VALUES ('billing', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        [JSON.stringify(data)],
      );
    },
  };
  return { describe: pgStore.describe, ...withPgFallback(pgStore) };
}

export function memoryBillingBackend(initial?: BillingData): BillingBackend {
  let data = initial ? structuredClone(initial) : undefined;
  return {
    describe: "memory",
    async load() { return data && structuredClone(data); },
    async save(next) { data = structuredClone(next); },
  };
}

const clampInt = (v: unknown, min: number, max: number) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};
const cleanText = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const cleanName = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

function normInterval(v: unknown): BillingInterval {
  return INTERVALS.includes(v as BillingInterval) ? (v as BillingInterval) : "monthly";
}

// The effective status at `now`: a stored "active"/"trial" whose period has
// ended reads as "expired" until it is renewed.
export function effectiveStatus(sub: Subscription, now: number): SubStatus {
  if (sub.status === "suspended" || sub.status === "expired") return sub.status;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd <= now) return "expired";
  return sub.status;
}

// Fills in fields added after a subscription was first saved.
function normalizeSub(sub: Subscription): Subscription {
  return {
    ...sub,
    sessionsUsed: Number(sub.sessionsUsed) || 0,
    urlsUsed: Number(sub.urlsUsed) || 0,
    extraSessionsUsed: Number(sub.extraSessionsUsed) || 0,
    graceSessions: Number(sub.graceSessions) || 0,
    graceLog: Array.isArray(sub.graceLog) ? sub.graceLog : [],
  };
}

// Starts a new period's usage from zero. A grace extension covers one period.
function resetUsage(sub: Subscription) {
  sub.sessionsUsed = 0;
  sub.urlsUsed = 0;
  sub.extraSessionsUsed = 0;
  sub.graceSessions = 0;
}

export type Entitlement = {
  subscribed: boolean;
  status: SubStatus | "none";
  reason?: "inactive" | "expired" | "suspended" | "quota" | "license";
  plan?: Plan;
  sessionsUsed: number;
  // The quota including any grace extension (0 = unlimited).
  sessionQuota: number;
  // The plan's own quota and the grace on top of it.
  planQuota: number;
  graceSessions: number;
  urlsUsed: number;
  extraSessionsUsed: number;
  remaining: number | null; // null = unlimited
  currentPeriodEnd: number | null;
  maxConcurrentViewers: number;
  maxSessionMinutes: number;
  licenseVersion: number;
  requireLicense: boolean;
};

export function createBilling(backend: BillingBackend, options: { secret?: string; clock?: () => number } = {}) {
  const clock = options.clock ?? Date.now;

  const plans: Plan[] = [];
  const subscriptions: Subscription[] = [];
  const payments: Payment[] = [];
  const history: SessionRecord[] = [];
  let storedSecret: string | undefined;

  let ready = false;
  let writing = Promise.resolve();

  const id = () => randomBytes(9).toString("base64url");

  async function init() {
    const loaded = await backend.load();
    if (loaded) {
      plans.push(...(Array.isArray(loaded.plans) ? loaded.plans : []));
      subscriptions.push(...(Array.isArray(loaded.subscriptions) ? loaded.subscriptions : []).map(normalizeSub));
      payments.push(...(Array.isArray(loaded.payments) ? loaded.payments : []));
      history.push(...(Array.isArray(loaded.history) ? loaded.history : []));
      storedSecret = loaded.secret;
    }
    if (!options.secret && !storedSecret) storedSecret = randomBytes(32).toString("base64url");
    if (!loaded || (storedSecret && !loaded.secret)) await persist();
    ready = true;
  }

  const secret = () => options.secret || storedSecret!;

  function persist() {
    const snapshot: BillingData = {
      plans: structuredClone(plans),
      subscriptions: structuredClone(subscriptions),
      payments: structuredClone(payments),
      history: structuredClone(history),
      secret: storedSecret,
    };
    writing = writing.then(() => backend.save(snapshot));
    return writing;
  }

  const planById = (pid: string | null | undefined) => (pid ? plans.find((p) => p.id === pid) : undefined);
  const subByAccount = (accountId: string) => subscriptions.find((s) => s.accountId === accountId);

  // Advances a subscription period that has lapsed, so quota usage is counted
  // against the correct window. Only auto-renewing active subscriptions roll
  // forward; others are left expired for the operator to renew.
  function rollIfLapsed(sub: Subscription, now: number) {
    if (sub.status === "suspended" || sub.status === "expired") return;
    const plan = planById(sub.planId);
    if (!plan || !sub.currentPeriodEnd || sub.currentPeriodEnd > now) return;
    if (!sub.autoRenew) {
      sub.status = "expired";
      sub.updatedAt = now;
      void persist();
      return;
    }
    const span = INTERVAL_DAYS[plan.interval] * DAY;
    let start = sub.currentPeriodStart;
    let end = sub.currentPeriodEnd;
    while (end <= now) {
      start = end;
      end += span;
    }
    sub.currentPeriodStart = start;
    sub.currentPeriodEnd = end;
    resetUsage(sub);
    sub.updatedAt = now;
    void persist();
  }

  function entitlementOf(accountId: string, now = clock()): Entitlement {
    const sub = subByAccount(accountId);
    if (!sub) {
      return {
        subscribed: false, status: "none", sessionsUsed: 0, sessionQuota: 0, planQuota: 0, graceSessions: 0, urlsUsed: 0, extraSessionsUsed: 0, remaining: null,
        currentPeriodEnd: null, maxConcurrentViewers: 0, maxSessionMinutes: 0, licenseVersion: 0, requireLicense: false,
      };
    }
    rollIfLapsed(sub, now);
    const plan = planById(sub.planId);
    const status = effectiveStatus(sub, now);
    const planQuota = plan?.sessionQuota ?? 0;
    // Grace only adds to a limited plan; an unlimited plan stays unlimited.
    const quota = planQuota > 0 ? planQuota + sub.graceSessions : 0;
    const remaining = quota > 0 ? Math.max(0, quota - sub.sessionsUsed) : null;
    let reason: Entitlement["reason"] | undefined;
    if (status === "suspended") reason = "suspended";
    else if (status === "expired") reason = "expired";
    else if (quota > 0 && sub.sessionsUsed >= quota) reason = "quota";
    return {
      subscribed: true,
      status,
      reason,
      plan,
      sessionsUsed: sub.sessionsUsed,
      sessionQuota: quota,
      planQuota,
      graceSessions: planQuota > 0 ? sub.graceSessions : 0,
      urlsUsed: sub.urlsUsed,
      extraSessionsUsed: sub.extraSessionsUsed,
      remaining,
      currentPeriodEnd: sub.currentPeriodEnd || null,
      maxConcurrentViewers: plan?.maxConcurrentViewers ?? 0,
      maxSessionMinutes: plan?.maxSessionMinutes ?? 0,
      licenseVersion: sub.licenseVersion,
      requireLicense: !!sub.requireLicense,
    };
  }

  // --- License tokens: a signed bundle the configured client carries. ---
  const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

  function issueLicense(accountId: string, raId: string) {
    const sub = subByAccount(accountId);
    const version = sub?.licenseVersion ?? 1;
    const body = `L1.${accountId}.${raId}.${version}.${clock().toString(36)}`;
    return `${body}.${sign(body)}`;
  }

  // Returns the identity a license proves, if the signature is valid. Does
  // not check the subscription status (the caller does that against the
  // current entitlement), but does reject a license whose version is stale.
  function verifyLicense(token: string | undefined): { accountId: string; raId: string; version: number } | undefined {
    if (!token || token.length > 300) return undefined;
    const parts = token.split(".");
    if (parts.length !== 6 || parts[0] !== "L1") return undefined;
    const body = parts.slice(0, 5).join(".");
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(parts[5]);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    const accountId = parts[1];
    const raId = parts[2];
    const version = parseInt(parts[3], 10);
    if (!accountId || !/^\d{6}$/.test(raId) || !Number.isFinite(version)) return undefined;
    const sub = subByAccount(accountId);
    if (sub && sub.licenseVersion !== version) return undefined;
    return { accountId, raId, version };
  }

  const toJSON = (): BillingData => ({
    plans: structuredClone(plans),
    subscriptions: structuredClone(subscriptions),
    payments: structuredClone(payments),
    history: structuredClone(history),
  });

  const api = {
    backend: backend.describe,
    get ready() { return ready; },

    // --- Plans ---
    listPlans(includeArchived = true) {
      return plans
        .filter((p) => includeArchived || !p.archived)
        .map((p) => ({ ...p }))
        .sort((a, b) => a.priceInr - b.priceInr);
    },
    getPlan(pid: string) {
      const p = planById(pid);
      return p ? { ...p } : undefined;
    },
    async createPlan(input: {
      name: string; description?: string; priceInr: number; interval: BillingInterval;
      sessionQuota?: number; maxConcurrentViewers?: number; maxSessionMinutes?: number;
    }) {
      const name = cleanName(input.name, 60);
      if (!name) throw new BillingError(400, "A plan needs a name.");
      const now = clock();
      const plan: Plan = {
        id: id(),
        name,
        description: cleanText(input.description, 240),
        priceInr: clampInt(input.priceInr, 0, 100_000_000),
        interval: normInterval(input.interval),
        sessionQuota: clampInt(input.sessionQuota, 0, 1_000_000),
        maxConcurrentViewers: clampInt(input.maxConcurrentViewers, 0, 100),
        maxSessionMinutes: clampInt(input.maxSessionMinutes, 0, 100_000),
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      plans.push(plan);
      await persist();
      return { ...plan };
    },
    async updatePlan(pid: string, change: Partial<Omit<Plan, "id" | "createdAt" | "updatedAt">>) {
      const plan = planById(pid);
      if (!plan) throw new BillingError(404, "That plan no longer exists.");
      if (change.name !== undefined) {
        const name = cleanName(change.name, 60);
        if (!name) throw new BillingError(400, "A plan needs a name.");
        plan.name = name;
      }
      if (change.description !== undefined) plan.description = cleanText(change.description, 240);
      if (change.priceInr !== undefined) plan.priceInr = clampInt(change.priceInr, 0, 100_000_000);
      if (change.interval !== undefined) plan.interval = normInterval(change.interval);
      if (change.sessionQuota !== undefined) plan.sessionQuota = clampInt(change.sessionQuota, 0, 1_000_000);
      if (change.maxConcurrentViewers !== undefined) plan.maxConcurrentViewers = clampInt(change.maxConcurrentViewers, 0, 100);
      if (change.maxSessionMinutes !== undefined) plan.maxSessionMinutes = clampInt(change.maxSessionMinutes, 0, 100_000);
      if (change.archived !== undefined) plan.archived = !!change.archived;
      plan.updatedAt = clock();
      await persist();
      return { ...plan };
    },
    async removePlan(pid: string) {
      const plan = planById(pid);
      if (!plan) throw new BillingError(404, "That plan no longer exists.");
      // A plan in use is archived rather than deleted, so history keeps it.
      const inUse = subscriptions.some((s) => s.planId === pid);
      if (inUse) {
        plan.archived = true;
        plan.updatedAt = clock();
        await persist();
        return { archived: true as const };
      }
      plans.splice(plans.indexOf(plan), 1);
      await persist();
      return { archived: false as const };
    },

    // --- Subscriptions ---
    // Every subscription with its effective status, for the dashboard.
    listSubscriptions(now = clock()) {
      return subscriptions.map((sub) => ({ ...sub, status: effectiveStatus(sub, now) }));
    },
    getSubscription(accountId: string) {
      const sub = subByAccount(accountId);
      return sub ? { ...sub } : undefined;
    },
    entitlement(accountId: string, now?: number) {
      return entitlementOf(accountId, now);
    },
    // Whether a company's PC may start a new session right now.
    canStartSession(accountId: string, now = clock()): { ok: boolean; reason?: Entitlement["reason"]; entitlement: Entitlement } {
      const ent = entitlementOf(accountId, now);
      // No subscription record at all → ungated (legacy company). Enforcement
      // begins once the operator gives the company a subscription.
      if (!ent.subscribed) return { ok: true, entitlement: ent };
      if (ent.reason) return { ok: false, reason: ent.reason, entitlement: ent };
      return { ok: true, entitlement: ent };
    },
    // Creates or replaces the subscription for a company. Assigning a plan
    // (re)starts the current period from `now` unless an explicit period is
    // given.
    async setSubscription(accountId: string, input: {
      planId?: string | null; status?: SubStatus; autoRenew?: boolean; requireLicense?: boolean; notes?: string;
      currentPeriodStart?: number; currentPeriodEnd?: number; resetUsage?: boolean;
    }) {
      if (!accountId) throw new BillingError(400, "Missing company.");
      const now = clock();
      let sub = subByAccount(accountId);
      const planId = input.planId !== undefined ? input.planId : sub?.planId ?? null;
      if (planId && !planById(planId)) throw new BillingError(404, "That plan no longer exists.");
      const plan = planById(planId);
      if (!sub) {
        sub = {
          accountId, planId: null, status: "active", startedAt: now,
          currentPeriodStart: now, currentPeriodEnd: 0, sessionsUsed: 0, urlsUsed: 0, extraSessionsUsed: 0,
          graceSessions: 0, graceLog: [], licenseVersion: 1, autoRenew: true, requireLicense: false, notes: "", createdAt: now, updatedAt: now,
        };
        subscriptions.push(sub);
      }
      const planChanged = planId !== sub.planId;
      sub.planId = planId;
      if (input.status !== undefined) sub.status = input.status;
      if (input.autoRenew !== undefined) sub.autoRenew = !!input.autoRenew;
      if (input.requireLicense !== undefined) sub.requireLicense = !!input.requireLicense;
      if (input.notes !== undefined) sub.notes = cleanText(input.notes, 500);
      if (input.currentPeriodStart !== undefined) sub.currentPeriodStart = input.currentPeriodStart;
      if (input.currentPeriodEnd !== undefined) {
        sub.currentPeriodEnd = input.currentPeriodEnd;
      } else if ((planChanged || !sub.currentPeriodEnd) && plan) {
        // Start a fresh period from the current period start.
        sub.currentPeriodStart = input.currentPeriodStart ?? now;
        sub.currentPeriodEnd = sub.currentPeriodStart + INTERVAL_DAYS[plan.interval] * DAY;
      }
      if (input.resetUsage || planChanged) resetUsage(sub);
      sub.updatedAt = now;
      await persist();
      return { ...sub };
    },
    // Renews the current period by one interval and records a payment as due.
    async renew(accountId: string, options: { markPaid?: boolean; amountInr?: number; method?: string; reference?: string } = {}) {
      const sub = subByAccount(accountId);
      if (!sub) throw new BillingError(404, "This company has no subscription yet.");
      const plan = planById(sub.planId);
      if (!plan) throw new BillingError(400, "Assign a plan before renewing.");
      const now = clock();
      const span = INTERVAL_DAYS[plan.interval] * DAY;
      const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
      sub.currentPeriodStart = base;
      sub.currentPeriodEnd = base + span;
      resetUsage(sub);
      sub.status = "active";
      sub.updatedAt = now;
      const payment = await api.addPayment(accountId, {
        amountInr: options.amountInr ?? plan.priceInr,
        interval: plan.interval,
        periodStart: sub.currentPeriodStart,
        periodEnd: sub.currentPeriodEnd,
        dueDate: sub.currentPeriodStart,
        status: options.markPaid ? "paid" : "due",
        method: options.method,
        reference: options.reference,
        note: `Renewal — ${plan.name}`,
      });
      await persist();
      return { subscription: { ...sub }, payment };
    },
    // Invalidates every license issued for this company (re-provision needed).
    // Grants extra usage on top of the plan quota for the current period, with
    // a remark for the record. Used when a company hits its quota mid-period.
    async addGrace(accountId: string, input: { amount: unknown; remarks?: unknown; by?: string }) {
      const sub = subByAccount(accountId);
      if (!sub) throw new BillingError(404, "This company has no subscription yet.");
      const plan = planById(sub.planId);
      if (!plan) throw new BillingError(400, "Assign a plan before adding a grace extension.");
      if (!(plan.sessionQuota > 0)) throw new BillingError(400, "This plan is unlimited, so it needs no grace extension.");
      const amount = Math.trunc(Number(input.amount));
      if (!Number.isFinite(amount) || amount < 1 || amount > 100_000) throw new BillingError(400, "Enter how many extra sessions to allow, from 1 to 100000.");
      const remarks = cleanText(input.remarks, 500);
      if (!remarks) throw new BillingError(400, "Add a remark saying why the grace extension was given.");
      const now = clock();
      rollIfLapsed(sub, now);
      sub.graceSessions += amount;
      sub.graceLog.unshift({ id: id(), amount, remarks, by: cleanName(input.by, 80), at: now, periodEnd: sub.currentPeriodEnd });
      if (sub.graceLog.length > MAX_GRACE_LOG) sub.graceLog.length = MAX_GRACE_LOG;
      sub.updatedAt = now;
      await persist();
      return { ...sub, graceLog: structuredClone(sub.graceLog) };
    },
    async revokeLicenses(accountId: string) {
      const sub = subByAccount(accountId);
      if (!sub) throw new BillingError(404, "This company has no subscription yet.");
      sub.licenseVersion += 1;
      sub.updatedAt = clock();
      await persist();
      return { ...sub };
    },
    async removeSubscription(accountId: string) {
      const i = subscriptions.findIndex((s) => s.accountId === accountId);
      if (i >= 0) { subscriptions.splice(i, 1); await persist(); }
    },

    // --- Licenses ---
    issueLicense,
    verifyLicense,
    // Validates a license presented for a company: "ok" (valid and for this
    // company), "mismatch" (valid but issued to another company), "invalid"
    // (bad signature or revoked), or "absent" (none presented).
    checkLicense(accountId: string, token: string | undefined): "ok" | "mismatch" | "invalid" | "absent" {
      if (!token) return "absent";
      const id = verifyLicense(token);
      if (!id) return "invalid";
      return id.accountId === accountId ? "ok" : "mismatch";
    },

    // --- Payments ---
    listPayments(accountId?: string, limit = 200) {
      return payments
        .filter((p) => !accountId || p.accountId === accountId)
        .sort((a, b) => b.dueDate - a.dueDate || b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async addPayment(accountId: string, input: {
      amountInr: number; interval?: BillingInterval | null; periodStart?: number | null; periodEnd?: number | null;
      dueDate?: number; status?: PaymentStatus; paidAt?: number | null; method?: string; reference?: string; note?: string;
    }) {
      if (!accountId) throw new BillingError(400, "Missing company.");
      const now = clock();
      const status = (["paid", "due", "overdue"] as const).includes(input.status as PaymentStatus) ? input.status! : "due";
      const payment: Payment = {
        id: id(),
        accountId,
        amountInr: clampInt(input.amountInr, 0, 100_000_000),
        interval: input.interval && INTERVALS.includes(input.interval) ? input.interval : null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        dueDate: Number.isFinite(input.dueDate) ? Number(input.dueDate) : now,
        status,
        paidAt: status === "paid" ? (input.paidAt ?? now) : null,
        method: cleanName(input.method, 40),
        reference: cleanName(input.reference, 80),
        note: cleanText(input.note, 240),
        createdAt: now,
      };
      payments.unshift(payment);
      if (payments.length > MAX_PAYMENTS) payments.length = MAX_PAYMENTS;
      await persist();
      return { ...payment };
    },
    async updatePayment(pid: string, change: {
      amountInr?: number; status?: PaymentStatus; paidAt?: number | null; dueDate?: number;
      method?: string; reference?: string; note?: string;
    }) {
      const payment = payments.find((p) => p.id === pid);
      if (!payment) throw new BillingError(404, "That payment no longer exists.");
      const now = clock();
      if (change.amountInr !== undefined) payment.amountInr = clampInt(change.amountInr, 0, 100_000_000);
      if (change.dueDate !== undefined && Number.isFinite(change.dueDate)) payment.dueDate = Number(change.dueDate);
      if (change.method !== undefined) payment.method = cleanName(change.method, 40);
      if (change.reference !== undefined) payment.reference = cleanName(change.reference, 80);
      if (change.note !== undefined) payment.note = cleanText(change.note, 240);
      if (change.status !== undefined && (["paid", "due", "overdue"] as const).includes(change.status)) {
        payment.status = change.status;
        payment.paidAt = change.status === "paid" ? (change.paidAt ?? payment.paidAt ?? now) : null;
      } else if (change.paidAt !== undefined) {
        payment.paidAt = change.paidAt;
      }
      await persist();
      return { ...payment };
    },
    async removePayment(pid: string) {
      const i = payments.findIndex((p) => p.id === pid);
      if (i < 0) throw new BillingError(404, "That payment no longer exists.");
      payments.splice(i, 1);
      await persist();
    },
    // Marks due payments whose due date has passed as overdue. Returns the
    // open (due/overdue) payments, upcoming-first.
    dues(now = clock()) {
      let changed = false;
      for (const p of payments) {
        if (p.status === "due" && p.dueDate < now - DAY) { p.status = "overdue"; changed = true; }
      }
      if (changed) void persist();
      const open = payments.filter((p) => p.status !== "paid");
      return {
        overdue: open.filter((p) => p.status === "overdue").sort((a, b) => a.dueDate - b.dueDate).map((p) => ({ ...p })),
        upcoming: open.filter((p) => p.status === "due").sort((a, b) => a.dueDate - b.dueDate).map((p) => ({ ...p })),
      };
    },

    // --- Session history & counting ---
    listSessions(filter: { accountId?: string; raId?: string } = {}, limit = 200) {
      return history
        .filter((h) => (!filter.accountId || h.accountId === filter.accountId) && (!filter.raId || h.raId === filter.raId))
        .slice(0, limit)
        .map((h) => ({ ...h }));
    },
    // Counts one unit of usage against a company's quota: a remote access URL
    // it authorized ("url"), or a session started while another of its
    // sessions was already live ("session"). Once the quota is reached, new
    // sessions are refused and the company gets no new Access PIN.
    async countUsage(accountId: string, kind: UsageKind) {
      const sub = subByAccount(accountId);
      if (!sub) return;
      rollIfLapsed(sub, clock());
      sub.sessionsUsed += 1;
      if (kind === "url") sub.urlsUsed += 1;
      else sub.extraSessionsUsed += 1;
      sub.updatedAt = clock();
      await persist();
    },
    // Kept for callers that count every session (older behavior).
    async countSession(accountId: string) {
      await api.countUsage(accountId, "session");
    },
    // Records an ended session in the history.
    async recordSession(record: Omit<SessionRecord, "id">) {
      const entry: SessionRecord = { id: id(), ...record };
      history.unshift(entry);
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
      await persist();
      return entry;
    },

    // --- Summaries for the console ---
    // Monthly recurring revenue across active subscriptions, in INR.
    summary(now = clock()) {
      let mrr = 0;
      let active = 0;
      let expired = 0;
      let suspended = 0;
      for (const sub of subscriptions) {
        const status = effectiveStatus(sub, now);
        const plan = planById(sub.planId);
        if (status === "active" || status === "trial") {
          active += 1;
          if (plan) mrr += plan.priceInr / (INTERVAL_DAYS[plan.interval] / 30);
        } else if (status === "expired") expired += 1;
        else if (status === "suspended") suspended += 1;
      }
      const { overdue, upcoming } = api.dues(now);
      const overdueAmount = overdue.reduce((t, p) => t + p.amountInr, 0);
      const since = now - 30 * DAY;
      const sessionsThisMonth = history.filter((h) => h.startedAt >= since).length;
      return {
        plans: plans.filter((p) => !p.archived).length,
        activeSubscriptions: active,
        expiredSubscriptions: expired,
        suspendedSubscriptions: suspended,
        mrrInr: Math.round(mrr),
        overdueCount: overdue.length,
        overdueAmountInr: overdueAmount,
        upcomingCount: upcoming.length,
        sessionsThisMonth,
      };
    },

    toJSON,
    flush() { return writing; },
  };

  return { init: init(), api };
}

export type Billing = ReturnType<typeof createBilling>["api"];
