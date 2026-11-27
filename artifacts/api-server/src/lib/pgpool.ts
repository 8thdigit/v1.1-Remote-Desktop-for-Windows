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
