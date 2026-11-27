import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LinkClaim } from "./msfwr";

// The remote access URL register: every URL a PC creates, which company
// authored it with which PIN, and the sessions opened through it. Kept on
// the same storage as the accounts (a file or PostgreSQL) so the record and
// the claims survive relay restarts.

export type LinkSession = { startedAt: number; endedAt: number; durationMs: number; viewers: number };

export type LinkRecord = {
  code: string;
  pcName: string;
  // The RA ID the PC pointed to when it created the URL.
  pcRa?: string;
  createdAt: number;
  expiresAt: number;
  ttlHours: number;
  revokedAt?: number;
  claim?: LinkClaim;
  sessions: LinkSession[];
};

type Data = { links: LinkRecord[] };

export type LinkLogBackend = {
  load(): Promise<Data | undefined>;
  save(data: Data): Promise<void>;
};

const MAX_RECORDS = 2000;
const MAX_SESSIONS = 50;

export function fileLinkLogBackend(dir: string): LinkLogBackend {
  const file = path.join(dir, "links.json");
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Data;
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

// One row in the msfwr_state table the accounts and billing already use.
export async function postgresLinkLogBackend(url: string): Promise<LinkLogBackend> {
  const { createPgPool, withPgFallback } = await import("./pgpool");
  const pool = await createPgPool(url);
  await pool.query("CREATE TABLE IF NOT EXISTS msfwr_state (id text PRIMARY KEY, data jsonb NOT NULL)");
  const pgStore: LinkLogBackend = {
    async load() {
      const r = await pool.query("SELECT data FROM msfwr_state WHERE id = 'links'");
      return r.rows[0]?.data as Data | undefined;
    },
    async save(data) {
      await pool.query(
        "INSERT INTO msfwr_state (id, data) VALUES ('links', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        [JSON.stringify(data)],
      );
    },
  };
  return withPgFallback(pgStore);
}

export function memoryLinkLogBackend(): LinkLogBackend {
  let data: Data | undefined;
  return {
    async load() { return data && structuredClone(data); },
    async save(next) { data = structuredClone(next); },
  };
}

export async function createLinkLog(backend: LinkLogBackend) {
  const loaded = await backend.load();
  const records: LinkRecord[] = Array.isArray(loaded?.links) ? loaded.links : [];
  let writing = Promise.resolve();
  const persist = () => {
    const snapshot: Data = { links: structuredClone(records) };
    writing = writing.then(() => backend.save(snapshot)).catch(() => {});
    return writing;
  };
  const find = (code: string) => records.find((r) => r.code === code);

  return {
    created(input: { code: string; name: string; ra?: string; createdAt: number; expiresAt: number; ttlHours: number }) {
      if (find(input.code)) return persist();
      records.unshift({
        code: input.code, pcName: input.name, pcRa: input.ra, createdAt: input.createdAt,
        expiresAt: input.expiresAt, ttlHours: input.ttlHours, sessions: [],
      });
      if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
      return persist();
    },
    // Records which company authorized a URL. The URL's own record is created
    // here when it is missing (a URL made before the register existed, or
    // before a relay restart that lost an unsaved write), so a claim is never
    // dropped.
    claimed(code: string, claim: LinkClaim, link?: { name: string; ra?: string; createdAt: number; expiresAt: number; ttlHours: number }) {
      let r = find(code);
      if (!r) {
        if (!link) return persist();
        r = { code, pcName: link.name, pcRa: link.ra, createdAt: link.createdAt, expiresAt: link.expiresAt, ttlHours: link.ttlHours, sessions: [] };
        records.unshift(r);
        if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
      }
      r.claim = { ...claim };
      return persist();
    },
    revoked(code: string, at: number) {
      const r = find(code);
      if (!r) return persist();
      r.revokedAt = at;
      return persist();
    },
    session(code: string, session: LinkSession) {
      const r = find(code);
      if (!r) return persist();
      r.sessions.unshift(session);
      if (r.sessions.length > MAX_SESSIONS) r.sessions.length = MAX_SESSIONS;
      return persist();
    },
    // Claims of URLs that have not expired yet, to restore after a restart.
    activeClaims(now: number) {
      return records.filter((r) => r.claim && r.expiresAt > now && !r.revokedAt).map((r) => ({ code: r.code, claim: r.claim! }));
    },
    list(filter: { accountId?: string } = {}, limit = 300) {
      return records
        .filter((r) => !filter.accountId || r.claim?.accountId === filter.accountId)
        .slice(0, limit)
        .map((r) => structuredClone(r));
    },
    flush() { return writing; },
  };
}

export type LinkLog = Awaited<ReturnType<typeof createLinkLog>>;
