import app from "./app";
import { logger } from "./lib/logger";
import { accountsReady, linkLogReady } from "./lib/portal";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Resilience against a flaky database region: an idle pg client error or a
// rejected background task (billing counter, watcher capture, buddy record)
// must never crash the relay process — that is what turns one bad read
// region into "Something went wrong on the relay" for every user. Requests
// that genuinely need the store still fail per-request through sendError,
// and the stores fall back to file storage at open time.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection; the relay keeps running");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception; the relay keeps running");
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // Load the login accounts now so the default admin exists from the start.
  accountsReady().catch((err) => logger.error({ err }, "Could not load login accounts"));
  linkLogReady().catch((err) => logger.error({ err }, "Could not load the remote access URL register"));
});
