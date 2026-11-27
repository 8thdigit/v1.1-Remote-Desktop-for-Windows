import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Site settings an admin controls from /admin, and the "Request access"
// registrations people send from the sign-in page. Stored as one document
// next to the accounts (the Render disk, or a row in PostgreSQL), so no
// migration is needed.

export type AssetKind = "logo" | "favicon" | "og";

export type Asset = { type: string; data: string; bytes: number; updatedAt: number };

export type PageContent = { enabled: boolean; title: string; body: string };

export type SiteSettings = {
  // Sections of the company portal. At least one stays visible.
  tabs: { pcs: boolean; connect: boolean; download: boolean; test: boolean };
  signIn: {
    // The "Request access" form on the sign-in page.
    requestAccess: boolean;
    // The "Download the app" link under the sign-in form.
    downloadLink: boolean;
  };
  og: { title: string; description: string };
  pages: { disclaimer: PageContent; privacy: PageContent };
  updatedAt: number;
};

export type RegistrationStatus = "pending" | "accepted" | "rejected";

// How a handled request ended: the person became a customer, or the query was
// answered and closed. Empty while it is still being worked on.
export type RegistrationOutcome = "" | "converted" | "closed";

export type RegistrationComment = { id: string; text: string; by: string; at: number };

export type Registration = {
  id: string;
  name: string;
  company: string;
  email: string;
  mobile: string;
  message: string;
  status: RegistrationStatus;
  // What the team plans to do about the request.
  actionPlan: string;
  outcome: RegistrationOutcome;
  // A running log of follow-ups (calls, WhatsApp messages, decisions).
  comments: RegistrationComment[];
  // Older single-line note; kept for requests saved before comments existed.
  note: string;
  createdAt: number;
  updatedAt: number;
};

const MAX_COMMENTS = 200;

// Brings a stored request up to date: "approved" and "dismissed" became
// "accepted" and "rejected", and an old note becomes the first comment.
function normalizeRegistration(raw: Registration): Registration {
  const r = { ...raw };
  const stored: string = raw.status;
  r.status = stored === "approved" || stored === "accepted" ? "accepted"
    : stored === "dismissed" || stored === "rejected" ? "rejected"
    : "pending";
  r.actionPlan = typeof r.actionPlan === "string" ? r.actionPlan : "";
  r.outcome = r.outcome === "converted" || r.outcome === "closed" ? r.outcome : "";
  r.comments = Array.isArray(r.comments) ? r.comments : [];
  r.note = typeof r.note === "string" ? r.note : "";
  if (r.note.trim() && r.comments.length === 0) {
    r.comments = [{ id: "note", text: r.note.trim(), by: "", at: r.updatedAt || r.createdAt }];
  }
  return r as Registration;
}

type SiteData = {
  settings?: Partial<SiteSettings>;
  assets?: Partial<Record<AssetKind, Asset>>;
  registrations?: Registration[];
};

export type SiteBackend = {
  load(): Promise<SiteData | undefined>;
  save(data: SiteData): Promise<void>;
  describe: string;
};

export const ASSET_LIMITS: Record<AssetKind, number> = {
  logo: 512 * 1024,
  favicon: 256 * 1024,
  og: 1536 * 1024,
};

const ASSET_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon"] as const;

const MAX_REGISTRATIONS = 2000;

export class SiteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_SETTINGS: SiteSettings = {
  tabs: { pcs: true, connect: true, download: true, test: false },
  signIn: { requestAccess: true, downloadLink: true },
  og: {
    title: "Connect.AI",
    description: "Connect.AI is attended remote support for Windows. The person at the PC shares a one-time code and confirms a verification number before a helper can connect.",
  },
  pages: {
    disclaimer: { enabled: false, title: "Disclaimer", body: "" },
    // An empty privacy body shows the built-in privacy notice.
    privacy: { enabled: true, title: "Privacy", body: "" },
  },
  updatedAt: 0,
};

export function fileSiteBackend(dir: string): SiteBackend {
  const file = path.join(dir, "site.json");
  return {
    describe: file,
    async load() {
      try {
        return JSON.parse(await readFile(file, "utf8")) as SiteData;
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

export async function postgresSiteBackend(url: string): Promise<SiteBackend> {
  const { createPgPool, withPgFallback } = await import("./pgpool");
  const pool = await createPgPool(url);
  await pool.query("CREATE TABLE IF NOT EXISTS msfwr_state (id text PRIMARY KEY, data jsonb NOT NULL)");
  const pgStore: SiteBackend = {
    describe: "PostgreSQL (DATABASE_URL)",
    async load() {
      const r = await pool.query("SELECT data FROM msfwr_state WHERE id = 'site'");
      return r.rows[0]?.data as SiteData | undefined;
    },
    async save(data) {
      await pool.query(
        "INSERT INTO msfwr_state (id, data) VALUES ('site', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        [JSON.stringify(data)],
      );
    },
  };
  return { describe: pgStore.describe, ...withPgFallback(pgStore) };
}

export function memorySiteBackend(initial?: SiteData): SiteBackend {
  let data = initial ? structuredClone(initial) : undefined;
  return {
    describe: "memory",
    async load() { return data && structuredClone(data); },
    async save(next) { data = structuredClone(next); },
  };
}

// Single-line text: no control characters or angle brackets.
const line = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// Multi-line text keeps newlines and tabs. It is always rendered as text.
const multi = (v: unknown, max: number) =>
  String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MOBILE = /^\+?[0-9][0-9 ()-]{5,22}$/;

function mergeSettings(stored: Partial<SiteSettings> | undefined): SiteSettings {
  const d = DEFAULT_SETTINGS;
  const s = stored ?? {};
  const page = (key: "disclaimer" | "privacy"): PageContent => ({
    enabled: bool(s.pages?.[key]?.enabled, d.pages[key].enabled),
    title: line(s.pages?.[key]?.title ?? d.pages[key].title, 80) || d.pages[key].title,
    body: multi(s.pages?.[key]?.body ?? d.pages[key].body, 50_000),
  });
  return {
    tabs: {
      pcs: bool(s.tabs?.pcs, d.tabs.pcs),
      connect: bool(s.tabs?.connect, d.tabs.connect),
      download: bool(s.tabs?.download, d.tabs.download),
      test: bool(s.tabs?.test, d.tabs.test),
    },
    signIn: {
      requestAccess: bool(s.signIn?.requestAccess, d.signIn.requestAccess),
      downloadLink: bool(s.signIn?.downloadLink, d.signIn.downloadLink),
    },
    og: {
      title: line(s.og?.title ?? d.og.title, 120),
      description: line(s.og?.description ?? d.og.description, 300),
    },
    pages: { disclaimer: page("disclaimer"), privacy: page("privacy") },
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
  };
}

// Reads a data: URL an admin uploaded and checks that it is the image type it
// claims to be, within the size limit for that slot.
export function parseImage(kind: AssetKind, dataUrl: unknown, now: number): Asset {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ""));
  if (!m) throw new SiteError(400, "Upload a PNG, JPEG, WebP, GIF, SVG or ICO image.");
  let type = m[1].toLowerCase();
  if (type === "image/vnd.microsoft.icon" || type === "image/ico") type = "image/x-icon";
  if (type === "image/jpg") type = "image/jpeg";
  if (!(ASSET_TYPES as readonly string[]).includes(type)) throw new SiteError(400, "Upload a PNG, JPEG, WebP, GIF, SVG or ICO image.");
  if (kind === "og" && (type === "image/svg+xml" || type === "image/x-icon")) {
    throw new SiteError(400, "Social networks only show PNG, JPEG, WebP or GIF share images.");
  }
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length) throw new SiteError(400, "That image is empty.");
  if (buf.length > ASSET_LIMITS[kind]) {
    throw new SiteError(413, `That image is too large. The limit is ${Math.round(ASSET_LIMITS[kind] / 1024)} KB.`);
  }
  const head = buf.subarray(0, 16);
  const ok =
    type === "image/png" ? head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) :
    type === "image/jpeg" ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff :
    type === "image/gif" ? head.subarray(0, 4).toString("latin1") === "GIF8" :
    type === "image/webp" ? head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" :
    type === "image/x-icon" ? head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0 :
    /<svg[\s>]/i.test(buf.subarray(0, 4096).toString("utf8"));
  if (!ok) throw new SiteError(400, "That file is not the image type it claims to be.");
  return { type, data: buf.toString("base64"), bytes: buf.length, updatedAt: now };
}

export function createSite(backend: SiteBackend, options: { clock?: () => number } = {}) {
  const clock = options.clock ?? Date.now;
  let settings = mergeSettings(undefined);
  let assets: Partial<Record<AssetKind, Asset>> = {};
  let registrations: Registration[] = [];

  let writing = Promise.resolve();
  const persist = () => {
    const snapshot: SiteData = { settings: structuredClone(settings), assets: { ...assets }, registrations: structuredClone(registrations) };
    writing = writing.then(() => backend.save(snapshot));
    return writing;
  };

  async function init() {
    const loaded = await backend.load();
    settings = mergeSettings(loaded?.settings);
    assets = loaded?.assets ?? {};
    registrations = Array.isArray(loaded?.registrations) ? loaded.registrations.map(normalizeRegistration) : [];
  }

  const assetInfo = (k: AssetKind) => {
    const a = assets[k];
    return a ? { url: `/api/site/asset/${k}?v=${a.updatedAt.toString(36)}`, type: a.type, bytes: a.bytes, updatedAt: a.updatedAt } : null;
  };

  const api = {
    backend: backend.describe,

    // What every visitor's page reads: the settings and where the images are.
    publicSettings() {
      return {
        ...structuredClone(settings),
        logo: assetInfo("logo"),
        favicon: assetInfo("favicon"),
        ogImage: assetInfo("og"),
      };
    },

    async updateSettings(change: unknown) {
      const c = (change && typeof change === "object" ? change : {}) as Partial<SiteSettings>;
      const next = mergeSettings({
        tabs: { ...settings.tabs, ...(c.tabs ?? {}) },
        signIn: { ...settings.signIn, ...(c.signIn ?? {}) },
        og: { ...settings.og, ...(c.og ?? {}) },
        pages: {
          disclaimer: { ...settings.pages.disclaimer, ...(c.pages?.disclaimer ?? {}) },
          privacy: { ...settings.pages.privacy, ...(c.pages?.privacy ?? {}) },
        },
      });
      if (!next.tabs.pcs && !next.tabs.connect && !next.tabs.download) {
        throw new SiteError(400, "Keep at least one portal section visible.");
      }
      next.updatedAt = clock();
      settings = next;
      await persist();
      return api.publicSettings();
    },

    getAsset(kind: AssetKind) { return assets[kind]; },

    async setAsset(kind: AssetKind, dataUrl: unknown) {
      assets = { ...assets, [kind]: parseImage(kind, dataUrl, clock()) };
      settings.updatedAt = clock();
      await persist();
      return api.publicSettings();
    },

    async removeAsset(kind: AssetKind) {
      const { [kind]: _gone, ...rest } = assets;
      assets = rest;
      settings.updatedAt = clock();
      await persist();
      return api.publicSettings();
    },

    // --- Registration requests ---
    async addRegistration(input: { name?: unknown; company?: unknown; email?: unknown; mobile?: unknown; message?: unknown }) {
      const name = line(input.name, 80);
      const company = line(input.company, 120);
      const email = line(input.email, 254).toLowerCase();
      const mobile = line(input.mobile, 24);
      const message = multi(input.message, 2000).trim();
      if (!name) throw new SiteError(400, "Enter your name.");
      if (!EMAIL.test(email)) throw new SiteError(400, "Enter a valid email address.");
      if (!MOBILE.test(mobile) || mobile.replace(/\D/g, "").length < 7) throw new SiteError(400, "Enter a valid mobile number, with the country code if outside India.");
      // The same email asking again while a request is still open only updates it.
      const open = registrations.find((r) => r.email === email && r.status === "pending");
      const now = clock();
      if (open) {
        Object.assign(open, { name, company, mobile, message: message || open.message, updatedAt: now });
        await persist();
        return { ...open };
      }
      const entry: Registration = {
        id: randomBytes(9).toString("base64url"),
        name, company, email, mobile, message,
        status: "pending", actionPlan: "", outcome: "", comments: [], note: "", createdAt: now, updatedAt: now,
      };
      registrations.unshift(entry);
      if (registrations.length > MAX_REGISTRATIONS) {
        // Drop the oldest closed requests first, never a pending one.
        for (let i = registrations.length - 1; i >= 0 && registrations.length > MAX_REGISTRATIONS; i--) {
          if (registrations[i].status !== "pending") registrations.splice(i, 1);
        }
        if (registrations.length > MAX_REGISTRATIONS) {
          registrations.shift();
          throw new SiteError(503, "We cannot take new requests right now. Try again later.");
        }
      }
      await persist();
      return { ...entry };
    },

    listRegistrations() { return registrations.map((r) => structuredClone(r)); },

    async updateRegistration(id: string, change: { status?: unknown; actionPlan?: unknown; outcome?: unknown; note?: unknown }) {
      const r = registrations.find((x) => x.id === id);
      if (!r) throw new SiteError(404, "That request no longer exists.");
      if (change.status !== undefined) {
        if (change.status !== "pending" && change.status !== "accepted" && change.status !== "rejected") {
          throw new SiteError(400, "Choose pending, accepted or rejected.");
        }
        r.status = change.status;
      }
      if (change.outcome !== undefined) {
        if (change.outcome !== "" && change.outcome !== "converted" && change.outcome !== "closed") {
          throw new SiteError(400, "Choose converted to customer or query closed.");
        }
        r.outcome = change.outcome;
        // An outcome means the request was handled.
        if (r.outcome && r.status === "pending") r.status = r.outcome === "converted" ? "accepted" : "rejected";
      }
      if (change.actionPlan !== undefined) r.actionPlan = multi(change.actionPlan, 4000);
      if (change.note !== undefined) r.note = multi(change.note, 1000);
      r.updatedAt = clock();
      await persist();
      return structuredClone(r);
    },

    async addRegistrationComment(id: string, text: unknown, by: string) {
      const r = registrations.find((x) => x.id === id);
      if (!r) throw new SiteError(404, "That request no longer exists.");
      const body = multi(text, 2000).trim();
      if (!body) throw new SiteError(400, "Write a comment first.");
      const now = clock();
      r.comments.push({ id: randomBytes(6).toString("base64url"), text: body, by: line(by, 80), at: now });
      if (r.comments.length > MAX_COMMENTS) r.comments.splice(0, r.comments.length - MAX_COMMENTS);
      r.updatedAt = now;
      await persist();
      return structuredClone(r);
    },

    async removeRegistrationComment(id: string, commentId: string) {
      const r = registrations.find((x) => x.id === id);
      if (!r) throw new SiteError(404, "That request no longer exists.");
      const i = r.comments.findIndex((c) => c.id === commentId);
      if (i < 0) throw new SiteError(404, "That comment no longer exists.");
      r.comments.splice(i, 1);
      r.updatedAt = clock();
      await persist();
      return structuredClone(r);
    },

    async removeRegistration(id: string) {
      const i = registrations.findIndex((x) => x.id === id);
      if (i < 0) throw new SiteError(404, "That request no longer exists.");
      registrations.splice(i, 1);
      await persist();
    },

    registrationCounts() {
      const counts = { pending: 0, accepted: 0, rejected: 0, converted: 0, closed: 0, total: registrations.length };
      for (const r of registrations) {
        counts[r.status] += 1;
        if (r.outcome) counts[r.outcome] += 1;
      }
      return counts;
    },

    flush() { return writing; },
  };

  return { init: init(), api };
}

export type Site = ReturnType<typeof createSite>["api"];
