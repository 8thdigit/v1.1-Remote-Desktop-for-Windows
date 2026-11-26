import { Router, type Request, type Response } from "express";
import type { Session } from "../lib/msfwr";
import { buddyReady, sendError, store, watcherReady } from "../lib/portal";

// Screenshots must reach the Inspect Buddy question watcher even when the
// AI Buddy master switch is off in the relay settings: the helper's panel is
// already open and taking shots on the remote desktop, so /capture answers
// with a neutral empty result and forwards text + image to the watcher.
// (The engine still ignores sessions whose per-session watcher is disabled.)
const EMPTY_CAPTURE = { issues: [] as string[], matches: [] as { id: string }[] };

// AI Buddy endpoints for the helper's viewer. They use the viewer's session
// token (the same one that reads the screen), so only someone already
// connected to a live session can send its screen text or ask for help.
const router = Router();

router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" });
  next();
});

function viewer(req: Request, res: Response) {
  const s = store.authenticate(req.get("authorization"), "viewer");
  if (!s) { res.status(410).json({ error: "This session ended or expired." }); return; }
  if (s.state !== "live") { res.status(409).json({ error: "Wait for the host to approve the session." }); return; }
  return s;
}

const meta = (s: Session) => ({
  id: s.id,
  pcName: s.name || s.call?.name || "",
  raId: s.operator?.raId ?? s.ra ?? "",
  operator: s.operator?.name ?? "",
  mode: s.via === "link" ? "link" as const : s.preapproved ? "unattended" as const : "attended" as const,
  startedAt: s.liveAt ?? s.createdAt,
});

// Per-session pacing: captures at most every 2 s, Claude at most every 6 s.
const lastCapture = new Map<string, number>();
const lastAssist = new Map<string, number>();
function paced(map: Map<string, number>, id: string, ms: number) {
  const now = Date.now();
  if (now - (map.get(id) ?? 0) < ms) return true;
  map.set(id, now);
  if (map.size > 2000) for (const [k, t] of map) if (now - t > 10 * 60_000) map.delete(k);
  return false;
}

const textOf = (req: Request) => {
  const text = (req.body as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text.slice(0, 20_000) : "";
};

// Optional JPEG screenshot the viewer may send with a capture, for the
// Inspect Buddy question watcher. Capped at ~4 MB decoded.
const imageOf = (req: Request) => {
  const raw = (req.body as { image?: unknown } | undefined)?.image;
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const b64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
    const buf = Buffer.from(b64, "base64");
    return buf.length > 100 && buf.length <= 4 * 1024 * 1024 ? buf : undefined;
  } catch { return undefined; }
};

router.get("/config", async (req, res) => {
  const s = store.authenticate(req.get("authorization"), "viewer");
  if (!s) { res.status(410).json({ error: "This session ended or expired." }); return; }
  try { res.json((await buddyReady()).clientConfig()); } catch (err) { sendError(res, err); }
});

router.post("/capture", async (req, res) => {
  const s = viewer(req, res);
  if (!s) return;
  try {
    // Inspect Buddy: forward the settled screen (and its screenshot) to the
    // question watcher engine FIRST and unconditionally — before the AI Buddy
    // master switch check. This is what fixes "screenshots are taken in the
    // AI buddy side bar but the question watcher never picks them up": when
    // AI Buddy was turned off globally the route answered 403 and the images
    // never reached the watcher at all. Fire-and-forget so the helper's
    // capture response never waits on watcher work. The engine itself still
    // ignores sessions whose per-session watcher is disabled. Errors are
    // logged, not swallowed, so a broken watcher store can't silently freeze
    // detection in "watching".
    void watcherReady()
      .then(async (w) => { await w.capture(s.id, meta(s), textOf(req), imageOf(req)); })
      .catch((err) => { console.warn("Inspect Buddy: watcher capture failed", err); });

    const buddy = await buddyReady();
    if (!buddy.clientConfig().enabled) { res.json(EMPTY_CAPTURE); return; }
    if (paced(lastCapture, s.id, 2000)) { res.status(429).json({ error: "Screens are being read too often." }); return; }
    res.json(buddy.capture(meta(s), textOf(req)));
  } catch (err) { sendError(res, err); }
});

router.post("/assist", async (req, res) => {
  const s = viewer(req, res);
  if (!s) return;
  try {
    const buddy = await buddyReady();
    if (!buddy.clientConfig().enabled) { res.status(403).json({ error: "AI Buddy is turned off." }); return; }
    if (paced(lastAssist, s.id, 6000)) { res.status(429).json({ error: "Wait a few seconds before asking again." }); return; }
    res.json(await buddy.assist(s.id, textOf(req)));
  } catch (err) { sendError(res, err); }
});

export default router;
