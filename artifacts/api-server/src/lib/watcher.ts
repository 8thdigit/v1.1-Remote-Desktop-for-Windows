import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// Inspect Buddy — Question Watcher engine.
//
// For every live remote session an admin can enable a "question watcher".
// The admin console (control room) sends settled screen text (OCR runs in the
// browser, no image leaves it) here. The engine:
//   1. spots the start of an exam on screen (exam-start heuristics + Claude),
//   2. captures each question as it appears, keeping them in order,
//   3. researches each question first in the uploaded document repository
//      (categories, BM25-style keyword scoring), then online (search engines)
//      when nothing is found locally,
//   4. produces a recommended answer for the remote admin to accept or correct,
//   5. on completion auto-generates two documents — the question paper and the
//      question-with-answer reading material — and stores them in the
//      repository for future reference.
//
// State lives in one JSON document next to the accounts (file or PostgreSQL row),
// like AI Buddy; images are stored as files under <dir>/watcher-imgs.

export type QuestionStatus = "pending" | "answered" | "accepted" | "corrected";

export type QuestionSource = "repo" | "online" | "ai";

export type WatcherQuestion = {
  n: number;                 // order within the exam
  at: number;                // when captured
  text: string;              // OCR text of the question (the "screenshot" content)
  image?: string;            // file name of the screenshot JPEG, if the viewer sent one
  options?: string[];        // MCQ options parsed out of the text
  status: QuestionStatus;
  answer: string;            // recommended / accepted answer
  explanation: string;
  source: QuestionSource | "";
  refs: string[];            // repo doc titles or URLs used
  confidence: number;        // 0..1
  correctedBy: string;       // admin who accepted/corrected
};

export type WatcherWatch = {
  sessionId: string;
  pcName: string;
  raId: string;
  operator: string;
  enabled: boolean;
  startedAt: number;
  endedAt?: number;
  // "" | "watching" (no exam yet) | "in-exam" | "completed"
  phase: "idle" | "watching" | "in-exam" | "completed";
  examTitle: string;
  questions: WatcherQuestion[];
  // Screenshot strip: every settled screen the AI Buddy panel forwards, in
  // capture order. The watcher detail view lists these on the left; when an
  // admin analyses one, it becomes (or merges into) a numbered question.
  shots: { id: string; at: number; image?: string; text: string; questionIndex?: number }[];
  // last question text seen, to detect a new question appearing
  lastSeen: string;
  notes: string;
  updatedAt: number;
  // titles of the documents stored in the repo when this watch completed
  storedDocs?: string[];
  // throttle for per-screen AI exam detection (in-memory, not persisted)
  lastDetect?: number;
};

export type RepoDoc = {
  id: string;
  title: string;
  category: string;
  text: string;             // extracted plain text (searchable)
  mime: string;
  bytes: number;
  fileName?: string;        // original upload name
  uploadedBy: string;
  uploadedAt: number;
};

export type WatcherSettings = {
  enabled: boolean;         // master switch for Inspect Buddy
  ai: boolean;              // use Claude for exam detection + answering
  webSearch: boolean;       // fall back to online research
  model: string;
  maxQuestions: number;
  updatedAt: number;
};

type Data = {
  settings?: Partial<WatcherSettings>;
  apiKey?: string;
  watches?: WatcherWatch[];
  docs?: RepoDoc[];
};

export type WatcherBackend = {
  load(): Promise<Data | undefined>;
  save(data: Data): Promise<void>;
  saveImage?(name: string, buf: Buffer): Promise<string>;
  removeImage?(name: string): Promise<void>;
  imageUrl?(name: string): string;
};

export class WatcherError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_WATCHES = 200;
const MAX_QUESTIONS = 200;
const MAX_SHOTS = 40;
const MAX_TEXT = 6000;
const MAX_DOCS = 500;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MODEL = "claude-opus-5-5";

export const DEFAULT_WATCHER_SETTINGS: WatcherSettings = {
  enabled: false, ai: false, webSearch: true, model: DEFAULT_MODEL, maxQuestions: 60, updatedAt: 0,
};

// --- Backends ---

export function fileWatcherBackend(dir: string): WatcherBackend {
  const file = path.join(dir, "watcher.json");
  const imgDir = path.join(dir, "watcher-imgs");
  return {
    async load() {
      try { return JSON.parse(await readFile(file, "utf8")) as Data; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    },
    async save(data) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await rename(tmp, file);
    },
    async saveImage(name, buf) {
      await mkdir(imgDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(imgDir, name), buf, { mode: 0o600 });
      return name;
    },
    async removeImage(name) {
      try { await unlink(path.join(imgDir, path.basename(name))); } catch { /* already gone */ }
    },
    imageUrl: (name) => `/api/watcher/img/${encodeURIComponent(name)}`,
  };
}

export async function postgresWatcherBackend(url: string): Promise<WatcherBackend> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query("CREATE TABLE IF NOT EXISTS msfwr_state (id text PRIMARY KEY, data jsonb NOT NULL)");
  return {
    async load() {
      const r = await pool.query("SELECT data FROM msfwr_state WHERE id = 'watcher'");
      return r.rows[0]?.data as Data | undefined;
    },
    async save(data) {
      await pool.query(
        "INSERT INTO msfwr_state (id, data) VALUES ('watcher', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        [JSON.stringify(data)],
      );
    },
  };
}

export function memoryWatcherBackend(): WatcherBackend {
  let data: Data | undefined;
  const imgs = new Map<string, Buffer>();
  return {
    async load() { return data && structuredClone(data); },
    async save(next) { data = structuredClone(next); },
    async saveImage(name, buf) { imgs.set(name, buf); return name; },
    async removeImage(name) { imgs.delete(name); },
    imageUrl: (name) => `/api/watcher/img/${encodeURIComponent(name)}`,
  };
}

// --- Text helpers ---

const line = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const multi = (v: unknown, max: number) =>
  String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);

export function cleanScreenText(v: unknown) {
  return multi(v, MAX_TEXT * 2)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[A-Za-z0-9]{2}/.test(l))
    .join("\n")
    .slice(0, MAX_TEXT);
}

// Exam-start signals on screen. Each pattern carries a weight so a single
// strong signal (an explicit "start exam" button, a countdown timer, an
// "attempt all questions" instruction line) is enough to enter the exam phase —
// previously two simultaneous keyword hits were required, which meant a real
// exam pager could stay stuck in "watching" forever.
const EXAM_START: { re: RegExp; w: number }[] = [
  { re: /\b(final exam|midterm|mock test|online test)\b/i, w: 3 },
  { re: /\b(exam|quiz|assessment)\b/i, w: 2 },
  { re: /\b(start|begin|resume|enter) (the )?exam\b/i, w: 3 },
  { re: /\btime (remaining|left)\b/i, w: 3 },
  { re: /\b(countdown|timer)\b/i, w: 2 },
  { re: /\b(attempt (all|any)|sections? and questions)\b/i, w: 2 },
  { re: /\b(total|maximum|passing) marks?\b/i, w: 2 },
  { re: /\bmarks:\s*\d/i, w: 2 },
  { re: /\b(proctor(ed)?|anticheat|full screen mode)\b/i, w: 2 },
  { re: /\b(test|exam) instructions?\b/i, w: 2 },
  { re: /\bsubmission (is|will) (be|auto)/i, w: 2 },
  { re: /\bmultiple[- ]choice\b/i, w: 1 },
  { re: /\b(select|choose) the (correct|best)\b/i, w: 1 },
];

// A question-shaped line: leading number or Q-number, ending with "?" or a
// colon, or carrying MCQ-style options right after it.
const QUESTION_NUM = /^\s*(?:q(?:uestion)?\.?\s*)?(\d{1,3})[).:\s]/i;
const OPTION_LINE = /^\s*\(?([a-dA-D])[\).]\s+(.{2,})$/;

export function questionShape(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let shaped = false;
  let opts = 0;
  for (const l of lines) {
    if (OPTION_LINE.test(l)) { opts++; continue; }
    if (QUESTION_NUM.test(l) && (l.includes("?") || lines.some((o) => OPTION_LINE.test(o)))) shaped = true;
    else if (/\?\s*$/.test(l) && l.length >= 20) shaped = true;
  }
  return shaped || opts >= 2;
}

// Weighted exam-start score over one screen capture. Returns the hit lines
// (for display) and whether the total weight crosses the start threshold.
export function detectExamStart2(text: string): { hits: string[]; score: number; exam: boolean } {
  const hits: string[] = [];
  let score = 0;
  for (const l of text.split("\n")) {
    for (const { re, w } of EXAM_START) {
      if (re.test(l)) {
        score += w;
        const h = l.slice(0, 160);
        if (!hits.includes(h) && hits.length < 6) hits.push(h);
        break; // one signal per line is enough
      }
    }
  }
  return { hits, score, exam: score >= 3 || (score >= 2 && questionShape(text)) };
}

// Back-compatible wrapper used by older callers/tests.
export function detectExamStart(text: string) {
  return detectExamStart2(text).hits;
}

// Parse a question block: leading number, body, A–D options.
export function parseQuestion(text: string): { num: number | null; stem: string; options: string[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let num: number | null = null;
  const stem: string[] = [];
  const options: string[] = [];
  for (const l of lines) {
    const om = l.match(OPTION_LINE);
    if (om) { options.push(`${om[1].toUpperCase()}. ${om[2]}`); continue; }
    const nm: RegExpMatchArray | null = stem.length === 0 && !num ? l.match(QUESTION_NUM) : null;
    if (nm) { num = Number(nm[1]); const rest = l.replace(QUESTION_NUM, "").trim(); if (rest) stem.push(rest); continue; }
    stem.push(l);
  }
  return { num, stem: stem.join("\n").slice(0, MAX_TEXT), options };
}

// Simple word-overlap score between a question and a document (BM25-lite).
const WORD = /[a-z0-9][a-z0-9'-]{2,}/g;
const STOP = new Set(["the","and","for","with","that","this","what","which","from","have","has","are","was","were","will","would","can","could","about","into","your","you","not","but","its","itself","they","them","their","there","when","where","who","how","why","does","did","done","some","most","more","than","then","also","only","just","over","under","out","off","all","any","each","other","such"]);

function terms(s: string) {
  const m = s.toLowerCase().match(WORD) ?? [];
  const t: string[] = [];
  for (const w of m) if (!STOP.has(w)) t.push(w);
  return t;
}

export function scoreDoc(question: string, doc: RepoDoc) {
  const q = [...new Set(terms(question))];
  if (!q.length) return 0;
  const hay = ` ${doc.title.toLowerCase()} ${doc.text.toLowerCase()} `;
  let score = 0;
  for (const t of q) if (hay.includes(` ${t}`) || hay.includes(t)) score += hay.includes(` ${t} `) ? 2 : 1;
  // Title matches weigh more.
  const th = ` ${doc.title.toLowerCase()} `;
  for (const t of q) if (th.includes(` ${t} `)) score += 2;
  return score / q.length;
}

// Extract a short relevant snippet around the best-matching terms.
function snippet(doc: RepoDoc, question: string) {
  const q = terms(question);
  const sentences = doc.text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20);
  let best = sentences[0] ?? doc.text.slice(0, 400);
  let bestScore = -1;
  for (const s of sentences.slice(0, 400)) {
    const sl = ` ${s.toLowerCase()} `;
    let sc = 0;
    for (const t of q) if (sl.includes(t)) sc += 1;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best.slice(0, 600);
}

// Very small HTML→text extraction for uploaded documents.
export function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Online research: fetch a search results page and pull candidate snippets.
async function webResearch(query: string, timeoutMs = 8000) {
  const q = encodeURIComponent(query.slice(0, 200));
  const urls = [
    `https://html.duckduckgo.com/html/?q=${q}`,
    `https://lite.duckduckgo.com/lite/?q=${q}`,
  ];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (const u of urls) {
      let res: Response;
      try {
        res = await fetch(u, { signal: ac.signal, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) InspectBuddy/1.0" } });
      } catch { continue; }
      if (!res.ok) continue;
      const html = await res.text();
      const text = htmlToText(html);
      // Pull result-ish lines with links where possible.
      const refs: string[] = [];
      for (const m of html.matchAll(/<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = m[1];
        if (/duckduckgo|google\.|bing\.com/.test(href)) continue;
        const label = htmlToText(m[2]).slice(0, 120);
        if (label.length >= 8 && !refs.some((r) => r.startsWith(href))) refs.push(`${href} — ${label}`);
        if (refs.length >= 5) break;
      }
      const excerpt = text.replace(/\s+/g, " ").slice(0, 3000);
      if (excerpt || refs.length) return { excerpt, refs };
    }
  } finally { clearTimeout(timer); }
  return { excerpt: "", refs: [] as string[] };
}

const newId = () => randomBytes(8).toString("hex");

// Word-overlap similarity 0..1 between two OCR texts, used to merge duplicate
// frames of the same screen and to detect a repeated question.
export function simWords(a: string, b: string) {
  const A = new Set(String(a).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean));
  const B = String(b).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!A.size || !B.length) return 0;
  let shared = 0;
  for (const t of B) if (A.has(t)) shared++;
  return shared / Math.max(A.size, B.length);
}

export function createWatcherEngine(backend: WatcherBackend, options: { clock?: () => number; envKey?: () => string | undefined } = {}) {
  const clock = options.clock ?? Date.now;
  const envKey = options.envKey ?? (() => process.env["ANTHROPIC_API_KEY"] || undefined);
  let settings: WatcherSettings = { ...DEFAULT_WATCHER_SETTINGS };
  let apiKey = "";
  const watches: WatcherWatch[] = [];
  const docs: RepoDoc[] = [];

  let writing = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const snapshot = (): Data => ({ settings, apiKey: apiKey || undefined, watches, docs });
  const persistNow = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const data = structuredClone(snapshot());
    writing = writing.then(() => backend.save(data)).catch(() => {});
    return writing;
  };
  const persistSoon = () => {
    timer ??= setTimeout(() => { timer = undefined; void persistNow(); }, 2000);
    timer.unref?.();
  };

  // A broken or unreachable store must never take the control room down:
  // load failures are logged and the engine starts with empty state. The
  // promise itself never rejects, so watcherReady() can't cache a failure.
  const init = (async () => {
    let loaded: Data | undefined;
    try {
      loaded = await backend.load();
    } catch (err) {
      console.warn("Inspect Buddy: could not load watcher state, starting empty", err);
      return;
    }
    try {
      if (loaded?.settings) settings = mergeSettings(loaded.settings);
      apiKey = typeof loaded?.apiKey === "string" ? loaded.apiKey : "";
      if (Array.isArray(loaded?.watches)) watches.push(...loaded.watches);
      if (Array.isArray(loaded?.docs)) docs.push(...loaded.docs);
    } catch (err) {
      console.warn("Inspect Buddy: watcher state is malformed, starting empty", err);
    }
  })();

  const key = () => apiKey || envKey() || "";
  // An OpenAI-compatible gateway (WATCHER_LLM_URL + WATCHER_LLM_KEY) counts
  // as an AI provider too, so the engine stays fully AI-guided without a
  // direct Anthropic key.
  const llmEnv = () => !!(process.env["WATCHER_LLM_URL"] && process.env["WATCHER_LLM_KEY"]);
  const aiReady = () => settings.enabled && settings.ai && (!!key() || llmEnv());
  let client: { key: string; client: Anthropic } | undefined;
  const anthropic = () => {
    const k = key();
    if (!k) throw new WatcherError(400, "Add an Anthropic API key in Inspect Buddy settings, or set ANTHROPIC_API_KEY on the relay.");
    if (client?.key !== k) client = { key: k, client: new Anthropic({ apiKey: k, timeout: 60_000, maxRetries: 1 }) };
    return client.client;
  };

  // Optional OpenAI-compatible fallback provider (any gateway): set
  // WATCHER_LLM_URL + WATCHER_LLM_KEY on the relay to use it when no
  // Anthropic key is configured — keeps the engine fully AI-guided.
  async function askOpenCompatible(system: string, user: string, maxTokens: number) {
    const url = process.env["WATCHER_LLM_URL"];
    const k = process.env["WATCHER_LLM_KEY"];
    if (!url || !k) throw new WatcherError(400, "No AI provider configured.");
    const res = await fetch(url.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
      body: JSON.stringify({
        model: settings.model && !settings.model.startsWith("claude-") ? settings.model : "gpt-4o-mini",
        max_tokens: maxTokens, temperature: 0.2,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new WatcherError(502, `LLM provider responded ${res.status}`);
    const j = await res.json() as { choices?: { message?: { content?: string } }[] };
    return String(j.choices?.[0]?.message?.content ?? "").trim();
  }

  async function ask(system: string, user: string, maxTokens: number) {
    if (!key()) return askOpenCompatible(system, user, maxTokens);
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

  const find = (sessionId: string) => watches.find((w) => w.sessionId === sessionId);

  // Add (or merge) a question captured from one screen. Duplicate detection is
  // similarity-based so a flashing/paging exam screen doesn't produce the same
  // question twice; later frames of the current question update it in place.
  // The merged-into question may be anywhere in the list (a pager that shows
  // an earlier question again), not only the newest one.
  function addQuestion(w: WatcherWatch, body: string, options: string[], image?: string, shotId?: string) {
    const cap = Math.min(MAX_QUESTIONS, settings.maxQuestions);
    const linkShot = (n: number) => { if (shotId) { const s = w.shots.find((x) => x.id === shotId); if (s) s.questionIndex = n; } };

    // Exact duplicate check across the whole list first (cheap, catches a
    // re-shown screen verbatim), then a similarity check against the most
    // recent questions (partial OCR / scrolling variants).
    const exact = w.questions.find((q) => q.text === body);
    const dupRecent = exact ?? w.questions.slice(-6).find((q) => simWords(q.text, body) >= 0.85);
    if (!dupRecent && simWords(w.lastSeen, body) < 0.85
      && w.questions.length < cap
      && (body.length >= 12 || options.length > 0)) {
      const q: WatcherQuestion = {
        n: w.questions.length + 1, at: clock(), text: body.slice(0, MAX_TEXT), image,
        options: options.slice(0, 8),
        status: "pending", answer: "", explanation: "", source: "", refs: [], confidence: 0, correctedBy: "",
      };
      w.questions.push(q);
      w.lastSeen = body;
      linkShot(q.n);
      void researchOne(w, q).then(() => persistSoon()).catch(() => { q.status = "pending"; });
      return q;
    }

    // Same question seen again: refresh its screenshot and grow the text when
    // the new frame reads more of it (scrolling / partial OCR).
    const cur = dupRecent ?? w.questions.at(-1);
    if (cur && (dupRecent || simWords(cur.text, body) >= 0.6)) {
      if (image) cur.image = image;
      if (body.length > cur.text.length * 1.15) cur.text = body.slice(0, MAX_TEXT);
      if (options.length > (cur.options?.length ?? 0)) cur.options = options.slice(0, 8);
      linkShot(cur.n);
      return null;
    }
    return null;
  }

  const DETECT_SYSTEM = [
    "You watch OCR text captured from a remote Windows screen during an IT support session.",
    "Decide whether the screen shows the START of an exam, quiz, test or assessment (an exam interface, instructions, timer, or the first numbered question).",
    "Reply in strict JSON only: {\"exam\": true|false, \"title\": \"short exam name or empty\", \"questionFound\": true|false}.",
    "If the screen shows ordinary desktop work, browsers, chats or error dialogs, exam is false.",
  ].join(" ");

  const ANSWER_SYSTEM = [
    "You prepare reading material for a proctored training review: given one exam question captured from a screen, plus research findings from the team's document repository and (optionally) online sources,",
    "produce the best-supported answer. Reply in strict JSON only:",
    "{\"answer\": \"the answer, option letter + text for MCQ\", \"explanation\": \"1-3 sentences citing which evidence supports it\", \"source\": \"repo|online|ai\", \"confidence\": 0..1}.",
    "Prefer repository evidence over online evidence over your own knowledge; say so in the explanation.",
    "If the evidence conflicts, pick the best-supported answer and lower the confidence.",
  ].join(" ");

  async function researchOne(w: WatcherWatch, q: WatcherQuestion) {
    // 1) Repository research, by category-relevance across all docs.
    const ranked = docs
      .map((d) => ({ d, s: scoreDoc(q.text, d) }))
      .filter((x) => x.s >= 0.18)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    const repoEvidence = ranked.map(({ d, s }) => `REPO[${d.category}] ${d.title} (score ${s.toFixed(2)}): ${snippet(d, q.text)}`).join("\n");
    let refs = ranked.map(({ d }) => `repo:${d.title}`);
    let source: QuestionSource | "" = ranked.length ? "repo" : "";
    let onlineEvidence = "";

    // 2) Online research when the repository has nothing good.
    if (!ranked.length && settings.webSearch) {
      const web = await webResearch(`${q.text.replace(/\s+/g, " ").slice(0, 180)}${q.options?.length ? " " + q.options.join("; ") : ""} answer`);
      if (web.excerpt || web.refs.length) {
        onlineEvidence = `ONLINE: ${web.excerpt.slice(0, 1500)}`;
        refs = web.refs.slice(0, 3);
        source = "online";
      }
    }

    // 3) Recommendation. With AI: structured JSON answer. Without: heuristic fallback.
    const evidence = [repoEvidence, onlineEvidence].filter(Boolean).join("\n\n");
    if (aiReady()) {
      try {
        const raw = await ask(ANSWER_SYSTEM, `<question>\n${q.text}\n${(q.options ?? []).join("\n")}\n</question>\n\n<evidence>\n${evidence || "No local or online evidence found."}\n</evidence>`, 900);
        const j = extractJson(raw);
        if (j) {
          q.answer = line(j.answer, 500);
          q.explanation = multi(j.explanation, 1200);
          q.source = (["repo", "online", "ai"].includes(String(j.source)) ? j.source : source || "ai") as QuestionSource;
          q.confidence = Math.min(1, Math.max(0, Number(j.confidence) || 0.5));
          q.refs = refs.slice(0, 5);
          q.status = "answered";
          return;
        }
      } catch { /* fall through to heuristic */ }
    }
    // Heuristic recommendation: first repository snippet sentence as the draft.
    if (ranked.length) {
      q.answer = snippet(ranked[0].d, q.text).slice(0, 400);
      q.explanation = `Recommended from repository document “${ranked[0].d.title}” (${ranked[0].d.category}). Verify before accepting.`;
      q.source = "repo";
      q.confidence = Math.min(0.6, ranked[0].s);
      q.refs = refs;
      q.status = "answered";
      return;
    }
    if (onlineEvidence) {
      q.answer = onlineEvidence.replace(/^ONLINE:\s*/, "").split(/(?<=[.!?])\s+/)[0]?.slice(0, 400) ?? "";
      q.explanation = "Found via online research; no repository match. Verify before accepting.";
      q.source = "online";
      q.confidence = 0.4;
      q.refs = refs;
      q.status = "answered";
      return;
    }
    q.status = "pending";
    q.explanation = "No answer found in the repository or online. An admin should answer this manually.";
  }

  // End of exam/session for one watch: mark completed and store the two
  // documents (reading material + questions & answers) in the repository.
  async function finalize(w: WatcherWatch, reason: string) {
    w.phase = "completed";
    const qs = w.questions;
    if (!qs.length) return;
    const stamp = new Date(w.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const titleBase = (w.examTitle || `Exam from ${w.pcName || "PC"}`).slice(0, 80);
    const questionsDoc = [
      `# ${titleBase} — Questions`,
      `Captured by Inspect Buddy question watcher (session ${w.sessionId}, ${reason}), ${new Date().toLocaleString()}.`,
      "",
      ...qs.map((q) => `**Q${q.n}.** ${q.text}${q.options?.length ? `\n${q.options.map((o) => `- ${o}`).join("\n")}` : ""}`),
    ].join("\n\n");
    const answersDoc = [
      `# ${titleBase} — Questions with Answers (reading material)`,
      `Prepared by the Inspect Buddy AI engine; reviewed by the remote admin. Session ${w.sessionId}.`,
      "",
      ...qs.map((q) => [
        `**Q${q.n}.** ${q.text}`,
        ...(q.options?.length ? q.options.map((o) => `- ${o}`) : []),
        `**Answer:** ${q.answer || "(unanswered — needs manual review)"}`,
        `_${q.explanation}${q.refs.length ? ` Sources: ${q.refs.join("; ")}` : ""}_ (status: ${q.status}, confidence ${(q.confidence * 100) | 0}%)`,
      ].join("\n")),
    ].join("\n\n");
    const stored: string[] = [];
    const addDoc = (title: string, text: string) => {
      const now = clock();
      docs.unshift({ id: newId(), title, category: "exam-captures", text, mime: "text/markdown", bytes: Buffer.byteLength(text), uploadedBy: "inspect-buddy", uploadedAt: now });
      if (docs.length > MAX_DOCS) docs.length = MAX_DOCS;
      stored.push(title);
    };
    addDoc(`${titleBase} — Questions (${stamp})`, questionsDoc);
    addDoc(`${titleBase} — Questions & Answers (${stamp})`, answersDoc);
    w.storedDocs = stored;
    w.notes = `${w.notes ? w.notes + "\n" : ""}Completed (${reason}): ${qs.length} question(s), ${qs.filter((q) => q.status === "pending").length} unanswered. Documents stored in repository category “exam-captures”.`;
  }

  const api = {
    init,
    // A session ended: mark its watcher completed and store the documents.
    async endSession(sessionId: string) { await api.complete(sessionId, "session ended"); },
    // --- Settings ---
    settings() { return { ...settings, apiKeySet: !!apiKey || llmEnv(), envKeySet: !!envKey() || llmEnv(), aiReady: aiReady() }; },
    async updateSettings(input: unknown) {
      const body = (input ?? {}) as Record<string, unknown>;
      const next = mergeSettings({ ...settings, ...pick(body, ["enabled", "ai", "webSearch", "model", "maxQuestions"]) });
      if (body["apiKey"] !== undefined) {
        const k = line(body["apiKey"], 300);
        if (k && !/^sk-ant-[\w-]{20,}$/.test(k)) throw new WatcherError(400, "That does not look like an Anthropic API key (it starts with sk-ant-).");
        apiKey = k; client = undefined;
      }
      settings = { ...next, updatedAt: clock() };
      await persistNow();
      return api.settings();
    },

    // --- Control room: watches per live session ---
    // Full clone of every watch record (used by the control-room route to
    // attach watcher state to each ongoing session row).
    list() { return structuredClone(watches); },
    listWatches() {
      return watches.map((w) => ({
        ...w,
        questionCount: w.questions.length,
        shotCount: w.shots.length,
        answeredCount: w.questions.filter((q) => q.status !== "pending").length,
        pendingReview: w.questions.filter((q) => q.status === "answered").length,
        questions: undefined,
        shots: undefined,
      }));
    },
    watch(sessionId: string) { return find(sessionId) && structuredClone(find(sessionId)!); },

    async enable(sessionId: string, meta: { pcName: string; raId: string; operator: string }) {
      if (!settings.enabled) throw new WatcherError(403, "Inspect Buddy is turned off in settings.");
      let w = find(sessionId);
      const now = clock();
      if (!w) {
        w = { sessionId, pcName: meta.pcName, raId: meta.raId, operator: meta.operator, enabled: true, startedAt: now, phase: "watching", examTitle: "", questions: [], shots: [], lastSeen: "", notes: "", updatedAt: now };
        watches.unshift(w);
        if (watches.length > MAX_WATCHES) watches.length = MAX_WATCHES;
      } else { w.enabled = true; w.phase = w.phase === "completed" ? "completed" : "watching"; w.updatedAt = now; }
      await persistNow();
      return { ...w, questions: undefined };
    },
    async disable(sessionId: string) {
      const w = find(sessionId);
      if (!w) throw new WatcherError(404, "No question watcher for that session.");
      w.enabled = false; w.updatedAt = clock();
      if (w.phase === "in-exam") await finalize(w, "stopped by admin");
      await persistNow();
      return { ...w, questions: undefined };
    },

    // One settled screen from the control-room monitor for this session.
    async capture(sessionId: string, meta: { pcName?: string; raId?: string; operator?: string } = {}, rawText: unknown, image?: Buffer) {
      let w = find(sessionId);
      if (!w && settings.enabled) {
        // The engine knows a live session that has no watcher record yet.
        w = { sessionId, pcName: meta.pcName ?? "", raId: meta.raId ?? "", operator: meta.operator ?? "", enabled: false, startedAt: clock(), phase: "idle", examTitle: "", questions: [], shots: [], lastSeen: "", notes: "", updatedAt: clock() };
        watches.unshift(w);
        if (watches.length > MAX_WATCHES) watches.length = MAX_WATCHES;
      }
      if (!w || !w.enabled) return { watching: false };
      if (w.phase === "completed") return { watching: true, phase: w.phase };
      const text = cleanScreenText(rawText);
      if (!text) return { watching: true, phase: w.phase };
      const now = clock();
      w.updatedAt = now;

      // Save the screenshot if the viewer sent one.
      let imageName: string | undefined;
      if (image && image.length > 100 && image.length <= MAX_DOC_BYTES && backend.saveImage) {
        imageName = `${sessionId}-${now}.jpg`;
        try { await backend.saveImage(imageName, image); } catch { imageName = undefined; }
      }

      // Screenshot strip: keep every settled screen with readable text, in
      // capture order, so the control room can show them under the session
      // even before an exam is detected. Consecutive frames of the same
      // static screen are merged into the newest one (no duplicates).
      if (imageName || text) {
        const last = w.shots.at(-1);
        const sameScreen = !!last && !!imageName === !!last.image &&
          (!text || !last.text || simWords(last.text, text) >= 0.9);
        if (sameScreen && last) {
          last.at = now;
          if (imageName) {
            if (last.image) void backend.removeImage?.(last.image).catch?.(() => {});
            last.image = imageName;
          }
          if (text) last.text = text;
        } else {
          w.shots.push({ id: newId(), at: now, image: imageName, text: text.slice(0, MAX_TEXT) });
          if (w.shots.length > MAX_SHOTS) {
            const dropped = w.shots.shift()!;
            if (dropped.image) void backend.removeImage?.(dropped.image).catch?.(() => {});
          }
        }
      }

      const det = detectExamStart2(text);
      const signals = det.hits;
      if (w.phase === "watching" || w.phase === "idle") {
        // Heuristic first: a strong weighted signal (or a medium signal plus
        // an actual question shape on screen) starts the capture immediately.
        let exam = det.exam;
        let title = "";
        // AI decides whenever the heuristic is inconclusive — not only when it
        // found some keywords. This is what keeps a flashing exam pager from
        // being stuck in "watching": Claude classifies every settled screen
        // while no exam has been detected yet (throttled per session).
        if (!exam && aiReady() && (signals.length > 0 || questionShape(text))) {
          // Throttle: at most one detection call per session every 6 s.
          if (now - (w.lastDetect ?? 0) >= 6000) {
            w.lastDetect = now;
            try {
              const j = extractJson(await ask(DETECT_SYSTEM, `<screen>\n${text.slice(0, 2500)}\n</screen>`, 200));
              if (j) { exam = !!j.exam; title = line(j.title, 120); }
            } catch { /* keep heuristic */ }
          }
        }
        if (exam) {
          w.phase = "in-exam";
          w.examTitle = title || signals[0]?.slice(0, 100) || "Exam on screen";
        }
      }

      let added: WatcherQuestion | null = null;
      if (w.phase === "in-exam") {
        const pq = parseQuestion(text);
        const body = (pq.stem || text).slice(0, MAX_TEXT);
        const shot = w.shots.at(-1);
        added = addQuestion(w, body, pq.options, imageName, shot?.id) ?? null;
      }

      persistSoon();
      return { watching: true, phase: w.phase, examTitle: w.examTitle, newQuestion: added?.n, issues: signals.slice(0, 3) };
    },

    // Admin override: start capturing now even if no exam signal was seen
    // (e.g., an exam pager whose OCR text never matches the heuristics).
    async forceExam(sessionId: string) {
      const w = find(sessionId);
      if (!w) throw new WatcherError(404, "No question watcher for that session.");
      if (!w.enabled) throw new WatcherError(409, "Enable the Question Watcher first.");
      if (w.phase === "completed") throw new WatcherError(409, "This watch is already completed.");
      w.phase = "in-exam";
      if (!w.examTitle) w.examTitle = "Exam (started manually)";
      w.lastSeen = "";
      w.updatedAt = clock();
      // Whatever screens already arrived become questions right away — the
      // strip on the left of the control room turns into the numbered list.
      const shots = [...w.shots];
      for (const s of shots) {
        const pq = parseQuestion(s.text || "");
        addQuestion(w, (pq.stem || s.text || "").slice(0, MAX_TEXT), pq.options, s.image, s.id);
      }
      await persistNow();
      return { ...w, questions: undefined, shots: undefined };
    },

    // Analyse one screenshot from the strip without waiting for automatic exam
    // detection: it becomes a numbered question (or merges into the current
    // one if it's the same text) and AI research starts immediately. The
    // watch flips to in-exam so following screens keep being captured.
    async analyseShot(sessionId: string, shotId: string) {
      const w = find(sessionId);
      if (!w) throw new WatcherError(404, "No question watcher for that session.");
      if (w.phase === "completed") throw new WatcherError(409, "This watch is already completed.");
      const shot = w.shots.find((s) => s.id === shotId);
      if (!shot) throw new WatcherError(404, "That screenshot is no longer in the strip.");
      if (shot.questionIndex && w.questions.some((q) => q.n === shot.questionIndex)) {
        const q = w.questions.find((x) => x.n === shot.questionIndex)!;
        await api.reResearch(sessionId, q.n);
        return { ...q };
      }
      const pq = parseQuestion(shot.text || "");
      const body = (pq.stem || shot.text || "").slice(0, MAX_TEXT);
      if (!body.trim()) throw new WatcherError(409, "No readable text was found on that screen.");
      w.phase = "in-exam";
      if (!w.examTitle) w.examTitle = "Exam (from screenshot)";
      w.updatedAt = clock();
      addQuestion(w, body, pq.options, shot.image, shot.id);
      await persistNow();
      const linked = w.shots.find((s) => s.id === shotId)?.questionIndex;
      const q = w.questions.find((x) => x.n === linked);
      if (q) await api.reResearch(sessionId, q.n);
      return { ...(q ?? { n: 0 }) };
    },

    // Admin accepts or corrects a recommended answer.
    async review(sessionId: string, n: number, input: { action: "accept" | "correct"; answer?: string; by: string }) {
      const w = find(sessionId);
      const q = w?.questions.find((x) => x.n === n);
      if (!w || !q) throw new WatcherError(404, "That question is not in the watcher record.");
      if (input.action === "accept") {
        if (q.status !== "answered") throw new WatcherError(409, "There is no recommendation to accept yet.");
        q.status = "accepted";
      } else {
        const a = multi(input.answer, 1000);
        if (!a) throw new WatcherError(400, "Write the corrected answer.");
        q.answer = a; q.status = "corrected"; q.confidence = 1;
        q.explanation = `Corrected by ${input.by}${q.explanation ? ` (was: ${q.explanation.slice(0, 200)})` : ""}`;
      }
      q.correctedBy = input.by;
      w.updatedAt = clock();
      await persistNow();
      return { ...q };
    },

    // End of exam/session: build the two documents and store them in the repo.
    async complete(sessionId: string, reason = "session ended") {
      const w = find(sessionId);
      if (!w) return;
      if (w.phase === "in-exam" || w.phase === "watching") await finalize(w, reason);
      w.endedAt = clock();
      w.updatedAt = clock();
      await persistNow();
    },

    // --- Document repository ---
    listDocs(category?: string) {
      const rows = docs.filter((d) => !category || d.category === category);
      return rows.map((d) => ({ ...d, text: undefined, preview: d.text.slice(0, 300) }));
    },
    categories() {
      const m = new Map<string, number>();
      for (const d of docs) m.set(d.category, (m.get(d.category) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    },
    doc(id: string) { return docs.find((d) => d.id === id) && structuredClone(docs.find((d) => d.id === id)!); },
    async uploadDoc(input: unknown, by: string) {
      if (!settings.enabled) throw new WatcherError(403, "Inspect Buddy is turned off in settings.");
      const body = (input ?? {}) as Record<string, unknown>;
      const title = line(body.title, 200);
      const category = (line(body.category, 80) || "general").toLowerCase();
      let text = multi(body.text, 400_000);
      const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl
        : typeof body.dataBase64 === "string" && (body.mime || body.filename)
          ? `data:${String(body.mime || guessMime(String(body.filename)))};base64,${body.dataBase64}`
          : "";
      const fileName = line(body.fileName, 200);
      if (!text && dataUrl) {
        const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/s);
        if (m) {
          const buf = Buffer.from(m[2], "base64");
          if (buf.length > MAX_DOC_BYTES) throw new WatcherError(400, "That file is larger than 8 MB.");
          if (/pdf/i.test(m[1])) text = pdfText(buf);
          else if (/zip|wordprocessingml/.test(m[1])) text = zipText(buf);
          else if (/html?|xml/.test(m[1])) text = htmlToText(buf.toString("utf8"));
          else text = buf.toString("utf8").replace(/[^\x20-\x7e\n\r\t]/g, " ");
        }
      }
      if (!title) throw new WatcherError(400, "Give the document a title.");
      if (!text.trim()) throw new WatcherError(400, "No readable text could be extracted from that document.");
      if (docs.length >= MAX_DOCS) throw new WatcherError(400, "The repository is full. Remove documents you no longer need.");
      const now = clock();
      const doc: RepoDoc = { id: newId(), title, category, text: text.slice(0, 400_000), mime: line(body.mime, 80) || "text/plain", bytes: Buffer.byteLength(text), fileName: fileName || undefined, uploadedBy: by, uploadedAt: now };
      docs.unshift(doc);
      await persistNow();
      return { ...doc, text: undefined, preview: doc.text.slice(0, 300) };
    },
    async removeDoc(id: string) {
      const i = docs.findIndex((d) => d.id === id);
      if (i < 0) throw new WatcherError(404, "That document no longer exists.");
      docs.splice(i, 1);
      await persistNow();
    },
    // Manual research endpoint the control room can call for one question.
    async reResearch(sessionId: string, n: number) {
      const w = find(sessionId);
      const q = w?.questions.find((x) => x.n === n);
      if (!w || !q) throw new WatcherError(404, "That question is not in the watcher record.");
      await researchOne(w, q);
      await persistNow();
      return { ...q };
    },

    // Inspect Buddy settings (master switch, AI, web search) — used by the
    // admin console and to guard enabling watchers / forwarding captures.
    getSettings() { return { ...settings }; },

    flush() { return persistNow(); },
  };

  return { init, api };
}

function extractJson(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

// Best-effort MIME type from a file name, used when the uploader sent raw
// base64 without an explicit content type.
function guessMime(name: string) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip",
    html: "text/html", htm: "text/html", xml: "application/xml", txt: "text/plain", md: "text/markdown",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", csv: "text/csv",
  };
  return map[ext] ?? "text/plain";
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function mergeSettings(stored: Partial<WatcherSettings>): WatcherSettings {
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const model = String(stored.model ?? "").trim();
  const maxQ = Number(stored.maxQuestions);
  return {
    enabled: bool(stored.enabled, DEFAULT_WATCHER_SETTINGS.enabled),
    ai: bool(stored.ai, DEFAULT_WATCHER_SETTINGS.ai),
    webSearch: bool(stored.webSearch, DEFAULT_WATCHER_SETTINGS.webSearch),
    model: /^claude-[a-z0-9.-]{3,60}$/.test(model) ? model : DEFAULT_MODEL,
    maxQuestions: Number.isFinite(maxQ) ? Math.min(MAX_QUESTIONS, Math.max(5, Math.round(maxQ))) : DEFAULT_WATCHER_SETTINGS.maxQuestions,
    updatedAt: Number(stored.updatedAt) || 0,
  };
}

// Minimal PDF text extraction: pull FlateDecode streams and keep printable ASCII.
function pdfText(buf: Buffer) {
  const chunks: string[] = [];
  const s = buf.toString("latin1");
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    const raw = buf.subarray(Buffer.from(s.slice(0, start), "latin1").length, Buffer.from(s.slice(0, end), "latin1").length);
    let data: Buffer;
    try { data = inflateSyncSafe(raw); } catch { data = raw; }
    const txt = data.toString("latin1");
    // Text show operators: (string) Tj  /  [(a)(b)] TJ
    for (const tm of txt.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*TJ?|\[((?:[^\]])*)\]\s*TJ/g)) {
      const inner = tm[1] ?? tm[2] ?? "";
      const parts = [...inner.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((p) => p[1]);
      const joined = (parts.length ? parts : [inner]).join("").replace(/\\(\d{1,3}|[()\\])/g, " ");
      if (joined.replace(/\s+/g, "").length > 1) chunks.push(joined);
    }
  }
  return chunks.join(" ").replace(/\s+/g, " ").slice(0, 400_000);
}

function inflateSyncSafe(buf: Buffer): Buffer {
  try { return require("node:zlib").inflateSync(buf, { finishFlush: require("node:zlib").constants.ZLIB_FINISH }); }
  catch { const zlib = require("node:zlib"); return zlib.inflateSync(buf); }
}

// DOCX/XLSX/ZIP: read stored (uncompressed) entries' text nodes.
function zipText(buf: Buffer) {
  const texts: string[] = [];
  const s = buf.toString("latin1");
  let idx = 0;
  while ((idx = s.indexOf("PK\u0003\u0004", idx)) >= 0) {
    const header = buf.subarray(idx, idx + 30);
    if (header.length < 30) break;
    const method = header.readUInt16LE(8);
    const compSize = header.readUInt32LE(18);
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const name = buf.subarray(idx + 30, idx + 30 + nameLen).toString("utf8");
    const dataStart = idx + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (/word\/document\.xml|xl\/sharedStrings\.xml|doc\.xml/.test(name) && method === 0) {
      texts.push(htmlToText(data.toString("utf8")).replace(/\s+/g, " "));
    } else if (/word\/document\.xml|xl\/sharedStrings\.xml/.test(name) && method === 8) {
      try { texts.push(htmlToText(require("node:zlib").inflateRawSync(data).toString("utf8")).replace(/\s+/g, " ")); } catch { /* skip */ }
    }
    idx = dataStart + compSize;
  }
  return texts.join("\n").slice(0, 400_000);
}

export type WatcherEngine = ReturnType<typeof createWatcherEngine>["api"];
