import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// AI Buddy: IT support assistance for live sessions.
//
// While a helper views a PC, their browser watches the screen for changes,
// reads the text of each settled screen (OCR runs in the helper's browser, so
// no image is uploaded) and sends that text here. The relay spots error
// messages, matches them against the support knowledge base, and can ask
// Claude for troubleshooting steps. When the session ends it writes a short
// summary for the admin console's session summaries.
//
// Everything lives in one document next to the accounts (a file on the Render
// disk, or a row in PostgreSQL), like the site settings and the URL register.

export type BuddyCapture = { at: number; text: string; issues: string[] };

export type BuddySession = {
  // The live session's internal id (the same id the admin console uses).
  id: string;
  pcName: string;
  raId: string;
  operator: string;
  mode: "attended" | "unattended" | "link";
  startedAt: number;
  endedAt?: number;
  captures: BuddyCapture[];
  // Every distinct problem line seen during the session.
  issues: string[];
  // Knowledge base entries suggested during the session.
  suggested: string[];
  summary: string;
  summaryBy: "" | "ai" | "auto";
  summaryAt: number;
  // What the helper or an admin wrote down: the notes and the fix.
  notes: string;
  resolution: string;
  updatedAt: number;
};

export type KbEntry = {
  id: string;
  title: string;
  // What the person sees: the error text, code or behaviour.
  symptoms: string;
  // Words or codes that point to this entry when they appear on screen.
  keywords: string[];
  // The fix, one step per line.
  steps: string;
  source: "builtin" | "admin" | "session";
  sessionId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  // How many times it was suggested in a live session.
  uses: number;
};

export type BuddySettings = {
  // On by default so a fresh relay works out of the box; an admin can still
  // turn AI Buddy off for every helper's viewer in Settings.
  enabled: boolean;
  // Ask Claude for troubleshooting steps and summaries.
  ai: boolean;
  // Ask Claude automatically whenever a captured screen shows a problem.
  autoAssist: boolean;
  model: string;
  // Fewest seconds between two screen captures.
  captureSeconds: number;
  updatedAt: number;
};

type Data = {
  settings?: Partial<BuddySettings>;
  // Kept apart from the settings so it is never sent to a browser.
  apiKey?: string;
  sessions?: BuddySession[];
  kb?: KbEntry[];
  seeded?: boolean;
};

export type BuddyBackend = {
  load(): Promise<Data | undefined>;
  save(data: Data): Promise<void>;
};

export class BuddyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_SESSIONS = 500;
const MAX_CAPTURES = 80;
const MAX_TEXT = 4000;
const MAX_ISSUES = 40;
const MAX_KB = 1000;
export const DEFAULT_MODEL = "claude-opus-5-5";

// AI Buddy ships ON so a freshly deployed relay works out of the box: the
// helper's side bar reads screens and the knowledge base matches immediately.
// AI features stay gated on an API key (aiReady() requires one), so enabling
// these flags without a key is harmless — the panel just skips Claude calls.
// An admin can still turn everything off in Settings; only the stored value
// overrides these defaults.
export const DEFAULT_BUDDY_SETTINGS: BuddySettings = {
  enabled: true,
  ai: true,
  autoAssist: true,
  model: DEFAULT_MODEL,
  captureSeconds: 8,
  updatedAt: 0,
};

export function fileBuddyBackend(dir: string): BuddyBackend {
  const file = path.join(dir, "buddy.json");
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

export async function postgresBuddyBackend(url: string): Promise<BuddyBackend> {
  const { createPgPool } = await import("./pgpool");
  const pool = await createPgPool(url);
  await pool.query("CREATE TABLE IF NOT EXISTS msfwr_state (id text PRIMARY KEY, data jsonb NOT NULL)");
  return {
    async load() {
      const r = await pool.query("SELECT data FROM msfwr_state WHERE id = 'buddy'");
      return r.rows[0]?.data as Data | undefined;
    },
    async save(data) {
      await pool.query(
        "INSERT INTO msfwr_state (id, data) VALUES ('buddy', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        [JSON.stringify(data)],
      );
    },
  };
}

export function memoryBuddyBackend(): BuddyBackend {
  let data: Data | undefined;
  return {
    async load() { return data && structuredClone(data); },
    async save(next) { data = structuredClone(next); },
  };
}

// --- Text helpers ---

const line = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const multi = (v: unknown, max: number) =>
  String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);

// Screen text as OCR returns it: keep the lines, drop noise-only ones.
export function cleanScreenText(v: unknown) {
  return multi(v, MAX_TEXT * 2)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[A-Za-z0-9]{2}/.test(l))
    .join("\n")
    .slice(0, MAX_TEXT);
}

// Lines that look like a technical problem on a Windows PC.
const PROBLEM = new RegExp([
  "\\berror\\b", "\\bfail(ed|ure|s)?\\b", "not responding", "stopped working", "has stopped", "crash",
  "access (is )?denied", "permission denied", "unauthori[sz]ed", "can(no|')t (connect|find|open|start|access|reach)", "could not", "couldn't", "unable to",
  "no internet", "not connected", "no network", "limited connectivity", "dns", "\\bERR_[A-Z_]+", "this site can.?t be reached", "server not found", "timed? ?out",
  "0x[0-9a-f]{6,8}", "stop code", "blue screen", "your pc ran into a problem", "bsod", "critical_process_died",
  "low (disk )?space", "disk (is )?full", "out of memory", "not enough memory",
  "is not recognized", "missing", "not found", "corrupt", "invalid", "expired", "activate windows", "licen[cs]e",
  "update(s)? (failed|couldn.?t|could not)", "install(ation)? (failed|error)", "driver", "offline", "printer", "paper jam",
  "warning", "virus", "threat", "blocked", "certificate", "password (is )?incorrect", "locked out", "sign.?in (failed|error)",
].join("|"), "i");

export function detectIssues(text: string) {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    if (!PROBLEM.test(l)) continue;
    const item = l.slice(0, 160);
    if (!out.includes(item)) out.push(item);
    if (out.length >= 6) break;
  }
  return out;
}

const CODE = /^(0x[0-9a-f]+|err_[a-z_]+|[a-z_]{6,}_[a-z_]+|\d{3,})$/i;

// Knowledge base entries whose keywords appear in the screen text, best first.
export function matchKb(text: string, kb: KbEntry[], limit = 3) {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const scored: { entry: KbEntry; score: number }[] = [];
  for (const entry of kb) {
    let score = 0;
    for (const raw of entry.keywords) {
      const k = raw.toLowerCase().trim();
      if (k.length < 3 || !hay.includes(k)) continue;
      score += CODE.test(k) ? 6 : k.includes(" ") ? 4 : 2;
    }
    if (score >= 4) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ entry, score }) => ({ ...entry, score }));
}

const keywordList = (v: unknown) => {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/);
  return [...new Set(list.map((k) => line(k, 60).toLowerCase()).filter((k) => k.length >= 3))].slice(0, 30);
};

// A starting knowledge base of common Windows support problems. Admins can
// edit or delete these, and add their own from the console or from a session.
const STARTER_KB: Omit<KbEntry, "id" | "createdAt" | "updatedAt" | "uses" | "createdBy" | "source">[] = [
  {
    title: "No internet or DNS errors in the browser",
    symptoms: "\"This site can't be reached\", DNS_PROBE_FINISHED_NXDOMAIN, ERR_NAME_NOT_RESOLVED, or \"No internet\" on the network icon.",
    keywords: ["dns_probe_finished_nxdomain", "err_name_not_resolved", "err_internet_disconnected", "this site can't be reached", "no internet", "dns server isn't responding"],
    steps: "Check the network icon: Wi-Fi connected or cable plugged in.\nRun the Windows network troubleshooter (Settings > Network & internet > Advanced > Network troubleshooter).\nIn an admin Command Prompt run: ipconfig /flushdns, then ipconfig /release and ipconfig /renew.\nTry another site to rule out a single site being down.\nIf it still fails, restart the router or switch, or set DNS to the company's DNS servers.",
  },
  {
    title: "Access is denied (0x80070005)",
    symptoms: "\"Access is denied\" or error 0x80070005 when opening, installing or changing something.",
    keywords: ["0x80070005", "access is denied", "access denied", "you need permission to perform this action"],
    steps: "Confirm the person is signed in with the right account.\nRetry with Run as administrator, if company policy allows it.\nCheck the file or folder's Security tab for the user's permissions.\nFor Windows Update, run the Windows Update troubleshooter and retry.\nEscalate to an admin account holder if elevation is needed.",
  },
  {
    title: "Windows Update fails to install",
    symptoms: "\"Some updates failed to install\", errors such as 0x800f0922, 0x80073712, 0x8024a105.",
    keywords: ["0x800f0922", "0x80073712", "0x8024a105", "0x800f081f", "updates failed", "update failed", "couldn't install"],
    steps: "Check free disk space on C: (at least 20 GB is safest).\nRun Settings > System > Troubleshoot > Other troubleshooters > Windows Update.\nIn an admin Command Prompt run: sfc /scannow, then DISM /Online /Cleanup-Image /RestoreHealth.\nRestart and retry the update.\nIf one update keeps failing, note its KB number and install it from the Microsoft Update Catalog.",
  },
  {
    title: "Low disk space",
    symptoms: "\"Low disk space\" warning, or the C: drive bar is red in File Explorer.",
    keywords: ["low disk space", "disk is full", "not enough space", "running out of disk space"],
    steps: "Open Settings > System > Storage and run Cleanup recommendations.\nEmpty the Recycle Bin and clear the Downloads folder after asking the person.\nTurn on Storage Sense.\nUninstall programs the person no longer uses.\nMove large personal files to OneDrive or a network share.",
  },
  {
    title: "Printer offline or not printing",
    symptoms: "Printer shows \"Offline\", jobs stuck in the queue, or \"Printer not activated\".",
    keywords: ["printer offline", "printer is offline", "error printing", "printer not activated", "print spooler", "paper jam"],
    steps: "Check the printer is on, has paper and shows no error on its panel.\nOpen Settings > Bluetooth & devices > Printers & scanners, select the printer and clear the queue.\nRestart the Print Spooler service (services.msc).\nRemove and re-add the printer, or reinstall its driver.\nFor network printers, ping the printer's IP address.",
  },
  {
    title: "App not responding or crashed",
    symptoms: "\"(Not Responding)\" in the title bar, or \"... has stopped working\".",
    keywords: ["not responding", "has stopped working", "stopped working", "application error", "0xc0000005"],
    steps: "Wait a minute in case the app is busy, then close it from Task Manager (Ctrl+Shift+Esc).\nCheck Task Manager for high CPU, memory or disk use.\nRestart the app, then the PC.\nInstall the app's updates, or repair it from Settings > Apps > Installed apps.\nCheck Event Viewer > Windows Logs > Application for the faulting module.",
  },
  {
    title: "Blue screen (stop code)",
    symptoms: "\"Your PC ran into a problem and needs to restart\" with a stop code.",
    keywords: ["your pc ran into a problem", "stop code", "critical_process_died", "irql_not_less_or_equal", "page_fault_in_nonpaged_area", "system_service_exception"],
    steps: "Write down the stop code and any file name shown.\nUndo recent changes: new drivers, hardware or updates.\nUpdate or roll back the driver named in the stop code.\nRun sfc /scannow and DISM /Online /Cleanup-Image /RestoreHealth.\nRun Windows Memory Diagnostic and check the disk with chkdsk /scan.",
  },
  {
    title: "Windows is not activated",
    symptoms: "\"Activate Windows\" watermark or an activation error code.",
    keywords: ["activate windows", "windows isn't activated", "0xc004f074", "0xc004c003", "activation error"],
    steps: "Open Settings > System > Activation to read the error.\nCheck the PC can reach the internet and the company's KMS server, if one is used.\nRun the Activation troubleshooter.\nConfirm the right license key or digital license is assigned with IT.",
  },
  {
    title: "Account locked out or password incorrect",
    symptoms: "\"The referenced account is currently locked out\" or \"The password is incorrect\".",
    keywords: ["locked out", "password is incorrect", "account is disabled", "your password has expired", "the user name or password is incorrect"],
    steps: "Check Caps Lock and the keyboard language.\nConfirm the account name and domain.\nUnlock or reset the account in the directory (Active Directory or Entra ID).\nAsk the person to sign in again and set a new password if prompted.",
  },
  {
    title: "Certificate or secure connection error",
    symptoms: "\"Your connection isn't private\", NET::ERR_CERT_DATE_INVALID, or a certificate warning in an app.",
    keywords: ["err_cert_date_invalid", "err_cert_authority_invalid", "your connection isn't private", "your connection is not private", "certificate error"],
    steps: "Check the PC's date, time and time zone; turn on Set time automatically.\nTry another site to see whether the problem is one site or all.\nFor a company site, check that the company's root certificate is installed.\nDo not tell the person to bypass the warning on an unknown site.",
  },
];

const newId = () => randomBytes(8).toString("hex");

export function createBuddy(backend: BuddyBackend, options: { clock?: () => number; envKey?: () => string | undefined } = {}) {
  const clock = options.clock ?? Date.now;
  const envKey = options.envKey ?? (() => process.env["ANTHROPIC_API_KEY"] || undefined);
  let settings: BuddySettings = { ...DEFAULT_BUDDY_SETTINGS };
  let apiKey = "";
  const sessions: BuddySession[] = [];
  const kb: KbEntry[] = [];
  let seeded = false;

  let writing = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const snapshot = (): Data => ({ settings, apiKey: apiKey || undefined, sessions, kb, seeded });
  const persistNow = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const data = structuredClone(snapshot());
    writing = writing.then(() => backend.save(data)).catch(() => {});
    return writing;
  };
  // Captures arrive every few seconds; batch their writes.
  const persistSoon = () => {
    timer ??= setTimeout(() => { timer = undefined; void persistNow(); }, 3000);
    timer.unref?.();
  };

  const init = (async () => {
    // A broken or unreachable store must never take the control room down:
    // load failures are logged and the engine starts with empty state. The
    // promise itself never rejects, so buddyReady() can't cache a failure.
    let loaded: Data | undefined;
    try {
      loaded = await backend.load();
    } catch (err) {
      console.warn("AI Buddy: could not load session records, starting empty", err);
      return;
    }
    try {
      if (loaded?.settings) settings = mergeSettings(loaded.settings);
      apiKey = typeof loaded?.apiKey === "string" ? loaded.apiKey : "";
      if (Array.isArray(loaded?.sessions)) sessions.push(...loaded.sessions);
      if (Array.isArray(loaded?.kb)) kb.push(...loaded.kb);
      seeded = !!loaded?.seeded;
    } catch (err) {
      console.warn("AI Buddy: session records are malformed, starting empty", err);
    }
    if (!seeded) {
      const now = clock();
      for (const e of STARTER_KB) kb.push({ ...e, id: newId(), source: "builtin", createdBy: "", createdAt: now, updatedAt: now, uses: 0 });
      seeded = true;
      await persistNow().catch(() => {});
    }
  })();

  const key = () => apiKey || envKey() || "";
  const aiReady = () => settings.enabled && settings.ai && !!key();
  let client: { key: string; client: Anthropic } | undefined;
  const anthropic = () => {
    const k = key();
    if (!k) throw new BuddyError(400, "Add an Anthropic API key in AI Buddy settings, or set ANTHROPIC_API_KEY on the relay.");
    if (client?.key !== k) client = { key: k, client: new Anthropic({ apiKey: k, timeout: 60_000, maxRetries: 1 }) };
    return client.client;
  };

  async function ask(system: string, user: string, maxTokens: number) {
    const response = await anthropic().beta.messages.create({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: user }],
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
    if (response.stop_reason === "refusal") return "";
    return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  }

  const find = (id: string) => sessions.find((s) => s.id === id);
  const publicSettings = () => ({
    ...settings,
    apiKeySet: !!apiKey,
    envKeySet: !!envKey(),
    aiReady: aiReady(),
  });

  function heuristicSummary(s: BuddySession) {
    const minutes = Math.max(1, Math.round(((s.endedAt ?? clock()) - s.startedAt) / 60_000));
    const parts = [`${s.captures.length} screen change${s.captures.length === 1 ? "" : "s"} read over about ${minutes} min.`];
    if (s.issues.length) parts.push(`Problems seen on screen: ${s.issues.slice(0, 5).map((i) => i.replace(/[.;:,\s]+$/, "")).join("; ")}.`);
    else parts.push("No error messages were spotted on screen.");
    const titles = s.suggested.map((id) => kb.find((e) => e.id === id)?.title).filter(Boolean);
    if (titles.length) parts.push(`Suggested knowledge base articles: ${titles.join("; ")}.`);
    if (s.resolution.trim()) parts.push(`Resolution: ${s.resolution.trim()}`);
    return parts.join(" ");
  }

  const SUMMARY_SYSTEM = [
    "You write short records of remote IT support sessions for a support team's admin console.",
    "You get the text read (by OCR, so it may be noisy) from the remote Windows screen each time it changed, with timestamps, plus any notes from the technician.",
    "Write 3 to 6 plain sentences: what the person was working on or what problem appeared, what was done, and how it ended or what follow-up is needed.",
    "Name error messages and codes exactly. Do not invent steps that the text does not show.",
    "Do not copy personal data such as passwords, card numbers or private messages into the summary.",
  ].join(" ");

  const ASSIST_SYSTEM = [
    "You are an IT support assistant for a technician who is remotely viewing a person's Windows PC with their permission.",
    "You get text read by OCR from the remote screen (it may be noisy) and, when available, matching articles from the team's knowledge base.",
    "If the screen shows a technical problem (an error dialog, error code, failed install or update, network, printer, account, performance or security warning),",
    "reply with: one line naming the problem, one line with the likely cause, then up to 6 numbered troubleshooting steps for the technician, most likely fix first.",
    "Use the knowledge base steps when they fit. Keep each step to one sentence. Warn before any step that could lose data.",
    "If the screen shows no technical problem, reply only: No IT issue is visible on this screen.",
    "Your job is technical support only: if the screen shows a quiz, test, exam, assessment or homework, do not answer or solve its questions; reply only: No IT issue is visible on this screen.",
  ].join(" ");

  const api = {
    // --- Settings ---
    settings() { return publicSettings(); },
    clientConfig() {
      return { enabled: settings.enabled, ai: aiReady(), autoAssist: aiReady() && settings.autoAssist, captureSeconds: settings.captureSeconds };
    },
    async updateSettings(input: unknown) {
      const body = (input ?? {}) as Record<string, unknown>;
      const next = mergeSettings({ ...settings, ...pick(body, ["enabled", "ai", "autoAssist", "model", "captureSeconds"]) });
      if (body["apiKey"] !== undefined) {
        const k = line(body["apiKey"], 300);
        if (k && !/^sk-ant-[\w-]{20,}$/.test(k)) throw new BuddyError(400, "That does not look like an Anthropic API key (it starts with sk-ant-).");
        apiKey = k;
        client = undefined;
      }
      settings = { ...next, updatedAt: clock() };
      await persistNow();
      return publicSettings();
    },

    // --- Live sessions ---
    // Stores one settled screen's text and returns what the helper's panel shows.
    capture(meta: { id: string; pcName: string; raId: string; operator: string; mode: BuddySession["mode"]; startedAt: number }, rawText: unknown) {
      if (!settings.enabled) throw new BuddyError(403, "AI Buddy is turned off.");
      const text = cleanScreenText(rawText);
      const now = clock();
      let s = find(meta.id);
      if (!s) {
        s = {
          ...meta, captures: [], issues: [], suggested: [], summary: "", summaryBy: "", summaryAt: 0, notes: "", resolution: "", updatedAt: now,
        };
        sessions.unshift(s);
        if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
      }
      const issues = detectIssues(text);
      const matches = matchKb(text, kb);
      const last = s.captures.at(-1);
      if (text && last?.text !== text) {
        s.captures.push({ at: now, text, issues });
        if (s.captures.length > MAX_CAPTURES) s.captures.splice(0, s.captures.length - MAX_CAPTURES);
      }
      for (const i of issues) if (!s.issues.includes(i) && s.issues.length < MAX_ISSUES) s.issues.push(i);
      for (const m of matches) {
        if (s.suggested.includes(m.id)) continue;
        s.suggested.push(m.id);
        const entry = kb.find((e) => e.id === m.id);
        if (entry) entry.uses += 1;
      }
      s.pcName ||= meta.pcName;
      s.operator ||= meta.operator;
      s.updatedAt = now;
      persistSoon();
      return { issues, matches: matches.map(kbView) };
    },
    // Troubleshooting steps for what is on screen now.
    async assist(sessionId: string, rawText: unknown) {
      if (!settings.enabled) throw new BuddyError(403, "AI Buddy is turned off.");
      const text = cleanScreenText(rawText);
      const issues = detectIssues(text);
      const matches = matchKb(text, kb);
      if (!aiReady()) return { issues, matches: matches.map(kbView), advice: "", ai: false };
      if (!text) return { issues, matches: matches.map(kbView), advice: "No text was read from the screen yet.", ai: true };
      const articles = matches.map((m) => `## ${m.title}\nSymptoms: ${m.symptoms}\nSteps:\n${m.steps}`).join("\n\n");
      const prompt = `<screen_text>\n${text}\n</screen_text>\n\n<knowledge_base>\n${articles || "No matching articles."}\n</knowledge_base>`;
      let advice = "";
      try { advice = await ask(ASSIST_SYSTEM, prompt, 2000); } catch (err) { throw aiError(err); }
      const s = find(sessionId);
      if (s) { s.updatedAt = clock(); persistSoon(); }
      return { issues, matches: matches.map(kbView), advice: advice || "No suggestion for this screen.", ai: true };
    },
    // Called when the live session ends.
    async ended(sessionId: string, endedAt: number) {
      const s = find(sessionId);
      if (!s) return;
      s.endedAt = endedAt;
      s.updatedAt = clock();
      await api.summarize(sessionId).catch(() => undefined);
    },
    async summarize(sessionId: string) {
      const s = find(sessionId);
      if (!s) throw new BuddyError(404, "AI Buddy has no screen record for that session.");
      let summary = "";
      let by: BuddySession["summaryBy"] = "auto";
      if (aiReady() && s.captures.length) {
        const start = s.startedAt;
        let transcript = s.captures.map((c) => `[+${Math.round((c.at - start) / 1000)}s]\n${c.text}`).join("\n\n");
        if (transcript.length > 60_000) transcript = transcript.slice(0, 20_000) + "\n\n[...]\n\n" + transcript.slice(-40_000);
        const notes = [s.notes && `Technician notes: ${s.notes}`, s.resolution && `Resolution: ${s.resolution}`].filter(Boolean).join("\n");
        try {
          summary = await ask(SUMMARY_SYSTEM, `PC: ${s.pcName || "Windows PC"}\n${notes}\n\n<screens>\n${transcript}\n</screens>`, 1500);
          if (summary) by = "ai";
        } catch { /* fall back to the automatic summary */ }
      }
      s.summary = summary || heuristicSummary(s);
      s.summaryBy = by;
      s.summaryAt = clock();
      await persistNow();
      return sessionView(s, true);
    },
    async updateSession(sessionId: string, input: unknown) {
      const s = find(sessionId);
      if (!s) throw new BuddyError(404, "AI Buddy has no screen record for that session.");
      const body = (input ?? {}) as Record<string, unknown>;
      if (body["notes"] !== undefined) s.notes = multi(body["notes"], 4000);
      if (body["resolution"] !== undefined) s.resolution = multi(body["resolution"], 4000);
      if (body["summary"] !== undefined) { s.summary = multi(body["summary"], 4000); s.summaryAt = clock(); }
      s.updatedAt = clock();
      await persistNow();
      return sessionView(s, true);
    },
    session(sessionId: string) {
      const s = find(sessionId);
      return s && sessionView(s, true);
    },
    sessionsIndex() {
      return new Map(sessions.map((s) => [s.id, sessionView(s, false)]));
    },
    async removeSession(sessionId: string) {
      const i = sessions.findIndex((s) => s.id === sessionId);
      if (i < 0) throw new BuddyError(404, "AI Buddy has no screen record for that session.");
      sessions.splice(i, 1);
      await persistNow();
    },

    // --- Knowledge base ---
    listKb() { return kb.map(kbView); },
    async addKb(input: unknown, by: string, from?: { source: KbEntry["source"]; sessionId?: string }) {
      const entry = kbFrom(input);
      if (kb.length >= MAX_KB) throw new BuddyError(400, "The knowledge base is full. Delete entries you no longer need.");
      const now = clock();
      const full: KbEntry = { ...entry, id: newId(), source: from?.source ?? "admin", sessionId: from?.sessionId, createdBy: by, createdAt: now, updatedAt: now, uses: 0 };
      kb.unshift(full);
      await persistNow();
      return kbView(full);
    },
    async updateKb(id: string, input: unknown) {
      const e = kb.find((k) => k.id === id);
      if (!e) throw new BuddyError(404, "That knowledge base entry no longer exists.");
      Object.assign(e, kbFrom({ ...e, ...(input as object) }), { updatedAt: clock() });
      await persistNow();
      return kbView(e);
    },
    async removeKb(id: string) {
      const i = kb.findIndex((k) => k.id === id);
      if (i < 0) throw new BuddyError(404, "That knowledge base entry no longer exists.");
      kb.splice(i, 1);
      await persistNow();
    },
    // A draft knowledge base entry from a session's problems and resolution.
    async kbFromSession(sessionId: string, by: string, input: unknown) {
      const s = find(sessionId);
      if (!s) throw new BuddyError(404, "AI Buddy has no screen record for that session.");
      const body = (input ?? {}) as Record<string, unknown>;
      const codes = s.issues.flatMap((i) => i.match(/0x[0-9a-f]{6,8}|\bERR_[A-Z_]+|\b[A-Z]{3,}(?:_[A-Z]+){2,}\b/gi) ?? []);
      return api.addKb({
        title: body["title"] ?? (s.issues[0] ? s.issues[0].slice(0, 100) : `Fix from ${s.pcName || "a session"}`),
        symptoms: body["symptoms"] ?? s.issues.slice(0, 4).join("\n"),
        keywords: body["keywords"] ?? [...codes, ...s.issues.slice(0, 2).map((i) => i.slice(0, 50))],
        steps: body["steps"] ?? s.resolution,
      }, by, { source: "session", sessionId });
    },

    flush() { return persistNow(); },
  };

  function kbFrom(input: unknown) {
    const body = (input ?? {}) as Record<string, unknown>;
    const title = line(body["title"], 140);
    const steps = multi(body["steps"], 6000);
    if (!title) throw new BuddyError(400, "Give the entry a title.");
    if (!steps) throw new BuddyError(400, "Write the fix steps, one per line.");
    const keywords = keywordList(body["keywords"]);
    if (keywords.length === 0) throw new BuddyError(400, "Add at least one keyword or error code to match on screen (3 characters or more).");
    return { title, symptoms: multi(body["symptoms"], 2000), keywords, steps };
  }

  return { init, api };
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function mergeSettings(stored: Partial<BuddySettings>): BuddySettings {
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const seconds = Number(stored.captureSeconds);
  const model = String(stored.model ?? "").trim();
  return {
    enabled: bool(stored.enabled, DEFAULT_BUDDY_SETTINGS.enabled),
    ai: bool(stored.ai, DEFAULT_BUDDY_SETTINGS.ai),
    autoAssist: bool(stored.autoAssist, DEFAULT_BUDDY_SETTINGS.autoAssist),
    model: /^claude-[a-z0-9.-]{3,60}$/.test(model) ? model : DEFAULT_MODEL,
    captureSeconds: Number.isFinite(seconds) ? Math.min(120, Math.max(3, Math.round(seconds))) : DEFAULT_BUDDY_SETTINGS.captureSeconds,
    updatedAt: Number(stored.updatedAt) || 0,
  };
}

const kbView = (e: KbEntry) => ({ ...e });

function sessionView(s: BuddySession, full: boolean) {
  const { captures, ...rest } = s;
  return {
    ...rest,
    captureCount: captures.length,
    lastCaptureAt: captures.at(-1)?.at ?? 0,
    ...(full ? { captures: captures.map((c) => ({ ...c })) } : {}),
  };
}

function aiError(err: unknown) {
  if (err instanceof BuddyError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new BuddyError(502, "The Anthropic API key was rejected. Check it in AI Buddy settings.");
  if (err instanceof Anthropic.RateLimitError) return new BuddyError(429, "Claude is rate limited right now. Try again in a minute.");
  if (err instanceof Anthropic.APIError) return new BuddyError(502, `Claude could not answer (${err.status ?? "network error"}). Try again.`);
  return new BuddyError(502, "Claude could not answer. Try again.");
}

export type Buddy = ReturnType<typeof createBuddy>["api"];
