import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import {
  AccountError, createAccounts, createActivityLog, fileBackend, loginTTL, postgresBackend,
  type Accounts, type PublicAccount,
} from "./accounts";
import {
  createBilling, fileBillingBackend, postgresBillingBackend, BillingError,
  type Billing, type Entitlement, type SubStatus,
} from "./billing";
import { createSite, fileSiteBackend, postgresSiteBackend, SiteError, type Site } from "./site";
import { createMsfwrStore, type EndedSession, type Session } from "./msfwr";
import { BuddyError, createBuddy, fileBuddyBackend, postgresBuddyBackend, type Buddy } from "./buddy";
import { createWatcherEngine, fileWatcherBackend, postgresWatcherBackend, WatcherError, type WatcherEngine } from "./watcher";
import { createLinkLog, fileLinkLogBackend, postgresLinkLogBackend, type LinkLog } from "./linklog";
import { logger } from "./logger";

// Shared relay state: the session store, the portal accounts, the billing
// store and the admin activity log.

// The session store reports live-starts and ended sessions to billing: each
// live-start counts against the owning company's quota, and each ended
// session is written to the history. Both are best-effort and keyed by the
// PC's RA ID, which is mapped to a company account here.
export const store = createMsfwrStore(Date.now, {
  onLive(session: Session) {
    // A session counts against the company that opened it: the signed-in
    // company, or the company whose PIN authored the remote access URL.
    const ra = session.operator?.raId ?? session.ra;
    if (!ra) return;
    // Only a session that starts while another of the company's sessions is
    // already live counts; remote access URLs count when they are authorized.
    // Checked now, before any await, so two sessions starting together are
    // not both counted as the extra one.
    const others = store.liveFor(ra).filter((x) => x.id !== session.id).length;
    if (others === 0) return;
    void (async () => {
      try {
        const account = (await accountsReady()).findRa(ra);
        if (account) await (await billingReady()).countUsage(account.id, "session");
      } catch (err) { logger.warn({ err }, "Could not count session for billing"); }
    })();
  },
  onEnd(ended: EndedSession) {
    void (async () => {
      try {
        const accounts = await accountsReady();
        const account = (ended.operatorId ? accounts.get(ended.operatorId) : undefined)
          ?? (ended.raId ? accounts.findRa(ended.raId) : undefined);
        if (ended.link) {
          await (await linkLogReady()).session(ended.link, {
            startedAt: ended.startedAt, endedAt: ended.endedAt, durationMs: ended.durationMs, viewers: ended.viewers,
          });
        }
        if (ended.sessionId) {
          const sessionId = ended.sessionId;
          void buddyReady().then((b) => b.ended(sessionId, ended.endedAt)).catch((err) => logger.warn({ err }, "Could not close the AI Buddy record"));
          void watcherReady().then((w) => w.complete(sessionId, "session ended")).catch((err) => logger.warn({ err }, "Could not close the Inspect Buddy watcher"));
        }
        await (await billingReady()).recordSession({
          sessionId: ended.sessionId,
          accountId: account?.id ?? null,
          raId: ended.raId,
          pcName: ended.pcName,
          mode: ended.mode,
          operator: ended.operator,
          startedAt: ended.startedAt,
          endedAt: ended.endedAt,
          durationMs: ended.durationMs,
          viewers: ended.viewers,
        });
      } catch (err) { logger.warn({ err }, "Could not record session history"); }
    })();
  },
  // The remote access URL register: creation, the authoring company, clearing.
  onLinkCreated(link) {
    void linkLogReady().then((log) => log.created(link)).catch((err) => logger.warn({ err }, "Could not record a new remote access URL"));
  },
  onLinkClaimed(code, claim, link) {
    void linkLogReady().then((log) => log.claimed(code, claim, link)).catch((err) => logger.warn({ err }, "Could not record a URL claim"));
    // Each remote access URL a company authorizes counts once against its quota.
    void billingReady().then((billing) => billing.countUsage(claim.accountId, "url")).catch((err) => logger.warn({ err }, "Could not count a URL for billing"));
  },
  onLinkRevoked(code, at) {
    void linkLogReady().then((log) => log.revoked(code, at)).catch((err) => logger.warn({ err }, "Could not record a cleared URL"));
  },
});
setInterval(store.sweep, 5000).unref();

export const activity = createActivityLog();

export const COOKIE = "msfwr_session";

// The built-in admin's password when ADMIN_PASSWORD is not set. It only
// works until the first sign-in, which requires choosing a new password.
export const DEFAULT_ADMIN_PIN = "121212";

async function open(): Promise<Accounts> {
  const url = process.env["DATABASE_URL"];
  let backend;
  if (url) {
    try {
      backend = await postgresBackend(url);
    } catch (err) {
      // Same guard as the buddy/watcher stores: when Postgres is unhealthy
      // (one region down, failover in progress, pool timeout), do not take
      // the portal down with it — fall back to the relay's file store so
      // sign-in and admin requests keep working instead of returning
      // "Something went wrong on the relay".
      console.warn("Accounts: store unavailable, falling back to file storage", err);
      backend = fileBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
    }
  } else {
    const dir = process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data");
    backend = fileBackend(dir);
  }
  const accounts = await createAccounts(backend, { secret: process.env["SESSION_SECRET"] });
  logger.info({ storage: accounts.backend, users: accounts.list().length }, "Login accounts loaded");
  if (accounts.empty) {
    const username = (process.env["ADMIN_USERNAME"] || "admin").toLowerCase();
    const password = process.env["ADMIN_PASSWORD"];
    try {
      await accounts.ensureDefaultAdmin({ username, password: password || DEFAULT_ADMIN_PIN, mustChangePassword: !password });
      logger.warn({ username }, password
        ? "Created the admin account from ADMIN_PASSWORD"
        : "Created the default admin account. Sign in at /admin with the default PIN and choose a new password");
    } catch (err) {
      // A bad ADMIN_PASSWORD should not take the whole relay down: fall back
      // to the default PIN so the admin can still sign in at /admin.
      logger.error({ err }, "ADMIN_PASSWORD was rejected; creating the admin account with the default PIN instead");
      await accounts.ensureDefaultAdmin({ username, password: DEFAULT_ADMIN_PIN, mustChangePassword: true });
    }
  }
  return accounts;
}

let opening: Promise<Accounts> | undefined;
export function accountsReady() {
  opening ??= open().catch((err) => {
    opening = undefined;
    throw err;
  });
  return opening;
}

// The billing store shares the accounts' storage location (the Render disk
// or PostgreSQL). Its license signing key is BILLING_SECRET when set, else
// the SESSION_SECRET, so licenses survive restarts like login cookies do.
async function openBilling(): Promise<Billing> {
  const dir = process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data");
  const url = process.env["DATABASE_URL"];
  let backend;
  if (url) {
    try {
      backend = await postgresBillingBackend(url);
    } catch (err) {
      console.warn("Billing: store unavailable, falling back to file storage", err);
      backend = fileBillingBackend(dir);
    }
  } else {
    backend = fileBillingBackend(dir);
  }
  const secret = process.env["BILLING_SECRET"] || process.env["SESSION_SECRET"];
  const { init, api } = createBilling(backend, { secret });
  await init;
  logger.info({ storage: api.backend, plans: api.listPlans().length }, "Billing store loaded");
  return api;
}

let openingBilling: Promise<Billing> | undefined;
export function billingReady() {
  openingBilling ??= openBilling().catch((err) => {
    openingBilling = undefined;
    throw err;
  });
  return openingBilling;
}

// The remote access URL register shares the accounts' storage location. Claims
// of URLs that are still valid are handed back to the session store, so a
// URL stays tied to the company that authored it across relay restarts.
async function openLinkLog(): Promise<LinkLog> {
  const url = process.env["DATABASE_URL"];
  let backend;
  if (url) {
    try {
      backend = await postgresLinkLogBackend(url);
    } catch (err) {
      console.warn("Link register: store unavailable, falling back to file storage", err);
      backend = fileLinkLogBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
    }
  } else {
    backend = fileLinkLogBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
  }
  const log = await createLinkLog(backend);
  store.restoreClaims(log.activeClaims(Date.now()));
  return log;
}

let openingLinkLog: Promise<LinkLog> | undefined;
export function linkLogReady() {
  openingLinkLog ??= openLinkLog().catch((err) => {
    openingLinkLog = undefined;
    throw err;
  });
  return openingLinkLog;
}

// The URL register as the consoles show it: the stored record plus the URL's
// live state. accountId limits it to the URLs one company authored.
export async function linkRegister(filter: { accountId?: string } = {}) {
  const log = await linkLogReady();
  const list = log.list(filter);
  const states = store.linkStates(list.map((r) => r.code));
  const now = Date.now();
  return list.map((r) => {
    const live = states.get(r.code);
    const status = r.revokedAt ? "cleared" as const : r.expiresAt <= now || !live ? "expired" as const : "active" as const;
    return {
      ...r,
      status,
      online: live?.online ?? false,
      viewers: live?.viewers ?? 0,
      locked: live?.locked ?? false,
      blocked: live?.blocked ?? false,
    };
  });
}

// Site settings and access requests share the accounts' storage location.
async function openSite(): Promise<Site> {
  const url = process.env["DATABASE_URL"];
  let backend;
  if (url) {
    try {
      backend = await postgresSiteBackend(url);
    } catch (err) {
      console.warn("Site settings: store unavailable, falling back to file storage", err);
      backend = fileSiteBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
    }
  } else {
    backend = fileSiteBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
  }
  const { init, api } = createSite(backend);
  await init;
  return api;
}

let openingSite: Promise<Site> | undefined;
export function siteReady() {
  openingSite ??= openSite().catch((err) => {
    openingSite = undefined;
    throw err;
  });
  return openingSite;
}

// Tests and local runs can point the site settings at another backend.
export function useSite(ready: Promise<Site>) { openingSite = ready; }

// Tests and local runs can point billing at another backend.
export function useBilling(ready: Promise<Billing>) { openingBilling = ready; }

export { BillingError };
export type { Entitlement, SubStatus };

// Maps the reason a company is blocked to a client-facing message. Used by
// the host endpoints that refuse registration for an inactive company.
export function subBlockMessage(reason: Entitlement["reason"]): string {
  switch (reason) {
    case "expired": return "This company's Connect.AI subscription has expired. Contact your provider to renew it.";
    case "suspended": return "This company's Connect.AI subscription is suspended. Contact your provider.";
    case "quota": return "This company has reached its usage limit (remote access URLs and extra sessions) for the current billing period. Ask your provider to renew or extend it.";
    case "license": return "This client's license is missing, invalid or revoked. Reconfigure it from the admin console.";
    default: return "This company's Connect.AI subscription is not active.";
  }
}

// Whether a PC that points to this RA ID may register and serve sessions.
// A company with no subscription on record is ungated (legacy); gating
// begins once an operator assigns it a subscription. When a license token is
// presented it is verified against the company, and when the subscription
// requires a license, a registration without a valid one is refused — this is
// what stops a cracked or copied client from impersonating a company or
// dodging revocation.
export async function gateForRa(
  raId: string | undefined,
  license?: string,
): Promise<{ ok: boolean; status: SubStatus | "none"; reason?: Entitlement["reason"]; message?: string }> {
  if (!raId) return { ok: true, status: "none" };
  try {
    const account = (await accountsReady()).findRa(raId);
    if (!account) return { ok: true, status: "none" };
    const billing = await billingReady();
    const sub = billing.getSubscription(account.id);
    if (!sub) return { ok: true, status: "none" };
    const ent = billing.entitlement(account.id);
    // License checks come first: a presented license that is forged, revoked
    // or issued to another company is always refused, and a company that
    // requires a license refuses anything without a valid one.
    const lic = billing.checkLicense(account.id, license);
    if (lic === "mismatch" || lic === "invalid" || (ent.requireLicense && lic !== "ok")) {
      return { ok: false, status: ent.status, reason: "license", message: subBlockMessage("license") };
    }
    const gate = billing.canStartSession(account.id);
    if (gate.ok) return { ok: true, status: gate.entitlement.status };
    return { ok: false, status: gate.entitlement.status, reason: gate.reason, message: subBlockMessage(gate.reason) };
  } catch (err) {
    // If billing cannot be read, do not take the whole relay down: fail open
    // so existing sessions keep working, and log it.
    logger.error({ err }, "Billing gate check failed; allowing session");
    return { ok: true, status: "none" };
  }
}

// Whether a company may connect one of its operators to a PC right now. This
// is the viewer-side counterpart of gateForRa: it gates the moment a session
// actually starts (accept, connect, join, link join), so that a company whose
// subscription is inactive, expired, suspended or over its session quota
// cannot open new sessions even if a PC is still registered. Unlike
// gateForRa it never checks a license — the viewer is the signed-in company,
// not the client binary, and the PC's license was already verified when it
// registered. A company with no subscription on record is ungated (legacy).
export async function connectGateForRa(
  raId: string | undefined,
): Promise<{ ok: boolean; status: SubStatus | "none"; reason?: Entitlement["reason"]; message?: string }> {
  if (!raId) return { ok: true, status: "none" };
  try {
    const account = (await accountsReady()).findRa(raId);
    if (!account) return { ok: true, status: "none" };
    const billing = await billingReady();
    if (!billing.getSubscription(account.id)) return { ok: true, status: "none" };
    const gate = billing.canStartSession(account.id);
    if (gate.ok) return { ok: true, status: gate.entitlement.status };
    return { ok: false, status: gate.entitlement.status, reason: gate.reason, message: subBlockMessage(gate.reason) };
  } catch (err) {
    logger.error({ err }, "Billing connect-gate check failed; allowing session");
    return { ok: true, status: "none" };
  }
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function setLogin(req: Request, res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: "strict", secure: req.secure, path: "/", maxAge: loginTTL,
  });
}

export function clearLogin(req: Request, res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { account?: PublicAccount }
  }
}

// Tests and local runs can point the accounts at another backend.
export function useAccounts(ready: Promise<Accounts>) { opening = ready; }

export async function currentUser(req: Request) {
  const accounts = await accountsReady();
  return accounts.session(readCookie(req, COOKIE));
}

// Cross-site requests cannot send JSON without a CORS preflight, and the
// login cookie is SameSite=Strict, so a JSON body is required for changes.
function jsonOnly(req: Request, res: Response) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return true;
  if (req.is("application/json")) return true;
  res.status(415).json({ error: "Send the request as JSON." });
  return false;
}

// Every signed-in route except changing the password is closed until an
// account with a default or admin-set password chooses its own.
export function requireUser(role?: "admin", options: { allowPasswordChange?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!jsonOnly(req, res)) return;
      const user = await currentUser(req);
      if (!user) { res.status(401).json({ error: "Sign in to continue." }); return; }
      if (user.mustChangePassword && !options.allowPasswordChange) {
        res.status(403).json({ error: "Choose a new password before continuing." });
        return;
      }
      if (role && user.role !== role) { res.status(403).json({ error: "Only admins can do that." }); return; }
      req.account = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function sendError(res: Response, err: unknown) {
  if (err instanceof AccountError || err instanceof BillingError || err instanceof SiteError || err instanceof BuddyError || err instanceof WatcherError) { res.status(err.status).json({ error: err.message }); return; }
  logger.error({ err }, "Portal request failed");
  res.status(500).json({ error: "Something went wrong on the relay. Try again." });
}

export const operatorOf = (u: PublicAccount) => ({ id: u.id, name: u.displayName, raId: u.raId });

// Simple fixed-window limiter keyed by a string, for sign-in attempts.
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { since: number; count: number }>();
  return {
    blocked(key: string) {
      const now = Date.now();
      const h = hits.get(key);
      return !!h && now - h.since < windowMs && h.count >= max;
    },
    fail(key: string) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || now - h.since >= windowMs) hits.set(key, { since: now, count: 1 });
      else h.count += 1;
      if (hits.size > 5000) for (const [k, v] of hits) if (now - v.since >= windowMs) hits.delete(k);
    },
    clear(key: string) { hits.delete(key); },
  };
}

// AI Buddy's screen records, knowledge base and settings share the accounts'
// storage location.
async function openBuddy(): Promise<Buddy> {
  const url = process.env["DATABASE_URL"];
  // Same guard as the watcher store: if Postgres can't be reached, fall
  // back to the relay's file store so Inspect Buddy / AI Buddy requests
  // never fail outright.
  let backend: ReturnType<typeof fileBuddyBackend>;
  try {
    backend = url ? await postgresBuddyBackend(url) : fileBuddyBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
  } catch (err) {
    console.warn("AI Buddy: store unavailable, falling back to file storage", err);
    backend = fileBuddyBackend(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"));
  }
  const { init, api } = createBuddy(backend);
  await init;
  return api;
}

let openingBuddy: Promise<Buddy> | undefined;
export function buddyReady() {
  openingBuddy ??= openBuddy().catch((err) => {
    openingBuddy = undefined;
    throw err;
  });
  return openingBuddy;
}

// Inspect Buddy: the question-watcher engine (control-room exam monitoring,
// document repository). Same storage choice as AI Buddy: Postgres when
// configured, otherwise a file in the relay's data directory. Screenshots are
// always written to disk (watcher-imgs under the data dir) so the admin
// console can stream them back, even when state lives in Postgres.
async function openWatcher(): Promise<WatcherEngine> {
  const dir = process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data");
  const imgDir = path.join(dir, "watcher-imgs");
  const fs = await import("node:fs/promises");
  const saveImage = async (name: string, buf: Buffer) => {
    await fs.mkdir(imgDir, { recursive: true });
    await fs.writeFile(path.join(imgDir, path.basename(name)), buf);
    return name;
  };
  const url = process.env["DATABASE_URL"];
  // If the watcher's Postgres table can't be opened (missing pg package,
  // pool timeout, migration drift), fall back to the relay's file store
  // instead of failing — otherwise every Inspect Buddy request errors out.
  let backend: Awaited<ReturnType<typeof fileWatcherBackend>>;
  try {
    backend = url ? await postgresWatcherBackend(url) : fileWatcherBackend(dir);
  } catch (err) {
    console.warn("Inspect Buddy: watcher store unavailable, falling back to file storage", err);
    backend = fileWatcherBackend(dir);
  }
  if (!backend.saveImage) backend.saveImage = saveImage;
  else {
    const inner = backend.saveImage.bind(backend);
    backend.saveImage = async (name, buf) => { await saveImage(name, buf); return inner(name, buf); };
  }
  backend.imageUrl ??= (name) => `/api/admin/buddy/img/${encodeURIComponent(name)}`;
  const { init, api } = createWatcherEngine(backend);
  await init;
  return api;
}

export const watcherImageDir = () => path.join(process.env["MSFWR_DATA_DIR"] || path.resolve(process.cwd(), ".data"), "watcher-imgs");

let openingWatcher: Promise<WatcherEngine> | undefined;
export function watcherReady() {
  openingWatcher ??= openWatcher().catch((err) => {
    openingWatcher = undefined;
    throw err;
  });
  return openingWatcher;
}
