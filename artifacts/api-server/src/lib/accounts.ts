import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeRaId } from "./msfwr";

// Login accounts for the relay. Admins manage the system from /admin;
// company accounts sign in to answer requests and connect to PCs. Every
// account has a unique RA (remote access) ID. A PC whose remote access points
// to an RA ID shows up for that company, and its Initiate requests reach it.

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type Role = "admin" | "company";

export type Account = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  raId: string;
  disabled: boolean;
  createdAt: number;
  lastLoginAt?: number;
  // Set while the account still has a password someone else chose (the
  // default admin PIN, or one an admin set). The owner must pick a new
  // password before using anything else.
  mustChangePassword?: boolean;
  // Bumped when the password changes or the account is disabled, which
  // invalidates every login token issued before.
  version: number;
  hash: string;
  salt: string;
};

export type PublicAccount = Omit<Account, "hash" | "salt" | "version">;

type Data = { users: Account[]; secret?: string };

export type Backend = {
  load(): Promise<Data | undefined>;
  save(data: Data): Promise<void>;
  describe: string;
};

// The session lifetime of a portal login.
export const loginTTL = 12 * 60 * 60_000;

export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export { formatRaId, normalizeRaId } from "./msfwr";

export function publicAccount(a: Account): PublicAccount {
  const { hash: _h, salt: _s, version: _v, ...rest } = a;
  return rest;
}

const cleanName = (v: string) => v.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80);

export function fileBackend(dir: string): Backend {
  const file = path.join(dir, "accounts.json");
  return {
    describe: file,
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

// Stores the whole account document as one row, so no migration step is
// needed when the relay runs with a database (DATABASE_URL).
export async function postgresBackend(url: string): Promise<Backend> {
  const { createPgPool, withPgFallback } = await import("./pgpool");
  const pool = await createPgPool(url);
  await pool.query("CREATE TABLE IF NOT EXISTS msfwr_state (id text PRIMARY KEY, data jsonb NOT NULL)");
  const pgStore: Backend = {
    describe: "PostgreSQL (DATABASE_URL)",
    async load() {
      const r = await pool.query("SELECT data FROM msfwr_state WHERE id = 'accounts'");
      return r.rows[0]?.data as Data | undefined;
    },
    async save(data) {
      await pool.query(
        "INSERT INTO msfwr_state (id, data) VALUES ('accounts', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        [JSON.stringify(data)],
      );
    },
  };
  return { describe: pgStore.describe, ...withPgFallback(pgStore) };
}

export function memoryBackend(initial?: Data): Backend {
  let data = initial ? structuredClone(initial) : undefined;
  return {
    describe: "memory",
    async load() { return data && structuredClone(data); },
    async save(next) { data = structuredClone(next); },
  };
}

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function hashPassword(password: string, salt = randomBytes(16)) {
  const key = await scrypt(password, salt, 32, SCRYPT);
  return { hash: key.toString("base64"), salt: salt.toString("base64") };
}

export function checkPassword(password: string) {
  if (typeof password !== "string" || password.length < 8) return "Passwords need at least 8 characters.";
  if (password.length > 200) return "That password is too long.";
  return undefined;
}

export async function createAccounts(backend: Backend, options: { secret?: string; clock?: () => number } = {}) {
  const clock = options.clock ?? Date.now;
  const loaded = await backend.load();
  const users: Account[] = Array.isArray(loaded?.users) ? loaded.users : [];
  let storedSecret = loaded?.secret;
  if (!options.secret && !storedSecret) storedSecret = randomBytes(32).toString("base64url");
  const secret = options.secret || storedSecret!;
  // A wrong-length dummy hash keeps login timing the same for unknown users.
  const dummy = await hashPassword(randomBytes(12).toString("hex"));

  let writing = Promise.resolve();
  const persist = () => {
    const snapshot: Data = { users: structuredClone(users), secret: storedSecret };
    writing = writing.then(() => backend.save(snapshot));
    return writing;
  };
  if (!loaded || (storedSecret && !loaded.secret)) await persist();

  const byId = (id: string) => users.find((u) => u.id === id);
  const byUsername = (username: string) => users.find((u) => u.username === username.toLowerCase());
  const byRa = (raId: string) => users.find((u) => u.raId === raId);

  function newRaId() {
    for (;;) {
      const id = String(randomInt(100000, 1000000));
      if (!byRa(id)) return id;
    }
  }
  // An admin may choose an RA ID (six digits) or leave it to be generated.
  function pickRaId(value: string | undefined, self?: Account) {
    if (!value?.trim()) return self?.raId ?? newRaId();
    const id = normalizeRaId(value);
    if (!id) throw new AccountError(400, "An RA ID is six digits, such as RA-123456.");
    const owner = byRa(id);
    if (owner && owner !== self) throw new AccountError(409, `RA-${id} already belongs to ${owner.displayName}.`);
    return id;
  }
  const roleError = "Choose the admin or company role.";

  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
  const activeAdmins = () => users.filter((u) => u.role === "admin" && !u.disabled);

  return {
    backend: backend.describe,
    get empty() { return users.length === 0; },
    list() { return users.map(publicAccount); },
    get(id: string) { const u = byId(id); return u && publicAccount(u); },
    findRa(raId: string) {
      const id = normalizeRaId(raId);
      const u = id ? byRa(id) : undefined;
      return u && !u.disabled ? publicAccount(u) : undefined;
    },

    // Creates the built-in admin when there are no accounts at all, with a
    // default password the admin must change at first sign-in. A six-digit
    // PIN is allowed here even though checkPassword needs 8+ characters.
    async ensureDefaultAdmin(input: { username: string; password: string; mustChangePassword: boolean }) {
      if (users.length) return undefined;
      const username = String(input.username).trim().toLowerCase();
      if (!USERNAME.test(username)) throw new AccountError(400, "ADMIN_USERNAME is not a valid login ID.");
      if (typeof input.password !== "string" || input.password.length < 6 || input.password.length > 200) {
        throw new AccountError(400, "The admin password needs at least 6 characters (set ADMIN_PASSWORD to a longer one for better security).");
      }
      const account: Account = {
        id: randomBytes(9).toString("base64url"),
        username,
        displayName: "Administrator",
        role: "admin",
        raId: newRaId(),
        disabled: false,
        createdAt: clock(),
        mustChangePassword: input.mustChangePassword,
        version: 1,
        ...(await hashPassword(input.password)),
      };
      users.push(account);
      await persist();
      return publicAccount(account);
    },

    async create(input: { username: string; displayName?: string; password: string; role: Role; raId?: string; mustChangePassword?: boolean }) {
      const username = String(input.username ?? "").trim().toLowerCase();
      if (!USERNAME.test(username)) throw new AccountError(400, "Login IDs are 3-32 characters: letters, digits, dot, dash or underscore.");
      if (byUsername(username)) throw new AccountError(409, "That login ID is already taken.");
      const problem = checkPassword(input.password);
      if (problem) throw new AccountError(400, problem);
      if (input.role !== "admin" && input.role !== "company") throw new AccountError(400, roleError);
      const raId = pickRaId(input.raId);
      const account: Account = {
        id: randomBytes(9).toString("base64url"),
        username,
        displayName: cleanName(input.displayName ?? "") || username,
        role: input.role,
        raId,
        disabled: false,
        createdAt: clock(),
        mustChangePassword: input.mustChangePassword ?? false,
        version: 1,
        ...(await hashPassword(input.password)),
      };
      users.push(account);
      await persist();
      return publicAccount(account);
    },

    async update(id: string, change: { displayName?: string; role?: Role; disabled?: boolean; password?: string; raId?: string }, actorId?: string) {
      const u = byId(id);
      if (!u) throw new AccountError(404, "That account no longer exists.");
      const demoting = (change.role === "company" && u.role === "admin") || (change.disabled === true && u.role === "admin" && !u.disabled);
      if (demoting && activeAdmins().length <= 1) throw new AccountError(409, "Keep at least one active admin.");
      if (actorId === id && (change.disabled === true || change.role === "company")) throw new AccountError(409, "You cannot disable or demote your own account.");
      const raId = change.raId !== undefined ? pickRaId(change.raId, u) : u.raId;
      if (change.role !== undefined && change.role !== "admin" && change.role !== "company") throw new AccountError(400, roleError);
      if (change.password !== undefined) {
        const problem = checkPassword(change.password);
        if (problem) throw new AccountError(400, problem);
        Object.assign(u, await hashPassword(change.password));
        // An admin chose this password, so the owner picks their own next.
        u.mustChangePassword = actorId !== id;
        u.version += 1;
      }
      if (change.displayName !== undefined) u.displayName = cleanName(change.displayName) || u.username;
      if (change.role !== undefined) u.role = change.role;
      u.raId = raId;
      if (change.disabled !== undefined && change.disabled !== u.disabled) {
        u.disabled = change.disabled;
        u.version += 1;
      }
      await persist();
      return publicAccount(u);
    },

    async remove(id: string, actorId?: string) {
      const u = byId(id);
      if (!u) throw new AccountError(404, "That account no longer exists.");
      if (actorId === id) throw new AccountError(409, "You cannot delete your own account.");
      if (u.role === "admin" && !u.disabled && activeAdmins().length <= 1) throw new AccountError(409, "Keep at least one active admin.");
      users.splice(users.indexOf(u), 1);
      await persist();
      return publicAccount(u);
    },

    async changePassword(id: string, current: string, next: string) {
      const u = byId(id);
      if (!u) throw new AccountError(404, "That account no longer exists.");
      const key = await scrypt(String(current ?? ""), Buffer.from(u.salt, "base64"), 32, SCRYPT);
      if (!timingSafeEqual(key, Buffer.from(u.hash, "base64"))) throw new AccountError(403, "The current password is not correct.");
      const problem = checkPassword(next);
      if (problem) throw new AccountError(400, problem);
      if (next === current) throw new AccountError(400, "Choose a new password that is different from the current one.");
      Object.assign(u, await hashPassword(next));
      u.mustChangePassword = false;
      u.version += 1;
      await persist();
      return publicAccount(u);
    },

    async verify(username: string, password: string) {
      const u = byUsername(String(username ?? "").trim());
      const salt = Buffer.from(u?.salt ?? dummy.salt, "base64");
      const key = await scrypt(String(password ?? ""), salt, 32, SCRYPT);
      const ok = timingSafeEqual(key, Buffer.from(u?.hash ?? dummy.hash, "base64"));
      if (!u || !ok) return undefined;
      if (u.disabled) throw new AccountError(403, "This account is disabled. Ask an admin to enable it.");
      u.lastLoginAt = clock();
      void persist().catch(() => {});
      return publicAccount(u);
    },

    issue(id: string) {
      const u = byId(id);
      if (!u) throw new AccountError(404, "That account no longer exists.");
      const body = `v1.${u.id}.${clock().toString(36)}.${u.version}`;
      return `${body}.${sign(body)}`;
    },

    // Returns the account a login token belongs to, if it is still valid.
    session(token: string | undefined) {
      if (!token || token.length > 200) return undefined;
      const parts = token.split(".");
      if (parts.length !== 5 || parts[0] !== "v1") return undefined;
      const body = parts.slice(0, 4).join(".");
      const expected = Buffer.from(sign(body));
      const given = Buffer.from(parts[4]);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
      const issued = parseInt(parts[2], 36);
      if (!Number.isFinite(issued) || clock() - issued > loginTTL || issued - clock() > 60_000) return undefined;
      const u = byId(parts[1]);
      if (!u || u.disabled || String(u.version) !== parts[3]) return undefined;
      return publicAccount(u);
    },

    flush() { return writing; },
  };
}

export type Accounts = Awaited<ReturnType<typeof createAccounts>>;

// Recent portal events for the admin console. Kept in memory only.
export type Activity = { at: number; kind: string; actor?: string; text: string };

export function createActivityLog(limit = 300, clock = Date.now) {
  const items: Activity[] = [];
  return {
    add(kind: string, text: string, actor?: string) {
      items.unshift({ at: clock(), kind, actor, text: text.slice(0, 200) });
      if (items.length > limit) items.length = limit;
    },
    list(max = 100) { return items.slice(0, max); },
  };
}
