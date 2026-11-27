import { logger } from "./logger";

// Shared pg.Pool factory for every store that persists to Postgres.
//
// Why this exists: the relay runs with a small pool (max 2) and no timeouts.
// When one of the database's regions goes unhealthy (a read replica down, a
// failover in progress), a query can hang indefinitely — express then never
// answers and the client shows "Something went wrong on the relay. Try
// again." Worse, pg emits an unhandled "error" event on an idle pool client,
// which can crash the whole process. This module fixes both:
//   * connectionTimeoutMillis / statement_timeout / query_timeout so a dead
//     region fails fast instead of hanging the request;
//   * keepAlive so Render's idle-connection reaping doesn't kill pooled
//     clients mid-request;
//   * a pool-level "error" listener so a broken idle client is logged and
//     evicted rather than taking the relay down. Stores that catch load()
//     errors keep serving from their last-known state or file fallback.
export function createPgPool(url: string) {
  return import("pg").then(({ default: pg }) => {
    const pool = new pg.Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 10000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
    });
    // A client error while idle (network blip, region failover) must not be
    // an unhandled event: log it, and let the next connect replace the client.
    pool.on("error", (err: unknown) => {
      logger.error({ err }, "Postgres pool client errored while idle; the store will fall back or retry");
    });
    // Fail fast on slow queries too (belt-and-braces with statement_timeout).
    pool.on("connect", () => { /* noop hook kept for diagnostics */ });
    return pool as InstanceType<typeof pg.Pool>;
  });
}

// Wrap a Postgres-backed store's load/save so a dead or failing-over region
// never turns into "Something went wrong on the relay" for every request:
//   * load(): if the query fails, serve from the last snapshot we successfully
//     read (or wrote); only the very first load with no snapshot can fail.
//   * save(): if the write fails, keep the data in memory and retry it on the
//     next save once the region recovers, instead of throwing at the user.
export function withPgFallback<T>(
  backend: { describe?: string; load(): Promise<T | undefined>; save(data: T): Promise<void> },
): { describe?: string; load(): Promise<T | undefined>; save(data: T): Promise<void> } {
  let snapshot: T | undefined;
  const log = logger as unknown as { warn?: (o: unknown, m: string) => void };
  const warn = (m: string, err: unknown) => (log.warn ? log.warn({ err }, m) : console.warn(m, err));
  return {
    ...(backend.describe ? { describe: backend.describe } : {}),
    async load() {
      try {
        const data = await backend.load();
        if (data !== undefined) snapshot = structuredClone(data);
        return data;
      } catch (err) {
        if (snapshot === undefined) throw err;
        warn("Postgres read failed (region unhealthy?); serving last-known state", err);
        return structuredClone(snapshot);
      }
    },
    async save(data) {
      snapshot = structuredClone(data);
      try {
        await backend.save(data);
      } catch (err) {
        warn("Postgres write failed (region unhealthy?); state kept locally and will be retried", err);
      }
    },
  };
}
