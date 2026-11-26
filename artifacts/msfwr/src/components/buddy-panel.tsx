import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Worker as OcrWorker } from 'tesseract.js';

// AI Buddy in the helper's viewer: watches the shared screen for changes,
// reads each settled screen with OCR in this browser (no image leaves it),
// and shows the problems it spots, matching knowledge base articles and,
// when an admin has turned it on, troubleshooting steps from Claude.

export type BuddyConfig = { enabled: boolean; ai: boolean; autoAssist: boolean; captureSeconds: number };

type KbMatch = { id: string; title: string; symptoms: string; steps: string; score: number };
type CaptureResult = { issues: string[]; matches: KbMatch[] };
// full is an object URL of the whole screen at its own size, kept only in
// this browser so the helper can open it larger.
type Capture = { at: number; thumb: string; full: string; text: string; issues: string[] };
const MAX_KEPT = 8;

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/buddy${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'omit', redirect: 'error',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || 'AI Buddy request failed');
  return data as T;
}

export function useBuddyConfig(token: string, live: boolean) {
  const [config, setConfig] = useState<BuddyConfig | null>(null);
  useEffect(() => {
    if (!live) return;
    let stop = false;
    call<BuddyConfig>(token, '/config').then((c) => { if (!stop) setConfig(c); }).catch(() => {});
    return () => { stop = true; };
  }, [token, live]);
  return config?.enabled ? config : null;
}

// A tiny grayscale picture of the screen, to tell when it changes.
const SIG_W = 48;
const SIG_H = 27;
function signature(img: HTMLImageElement, canvas: HTMLCanvasElement) {
  canvas.width = SIG_W;
  canvas.height = SIG_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SIG_W, SIG_H);
  const { data } = ctx.getImageData(0, 0, SIG_W, SIG_H);
  const out = new Uint8Array(SIG_W * SIG_H);
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10;
  return out;
}
function difference(a: Uint8Array, b: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const timeFmt = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function BuddyPanel({ token, frame, config }: { token: string; frame?: string; config: BuddyConfig }) {
  const [watching, setWatching] = useState(true);
  const [status, setStatus] = useState<'idle' | 'loading' | 'reading' | 'error'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [advice, setAdvice] = useState<{ text: string; at: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // The capture shown larger, by its time.
  const [viewing, setViewing] = useState<number | null>(null);
  const capturesRef = useRef<Capture[]>([]);
  capturesRef.current = captures;
  useEffect(() => () => { for (const c of capturesRef.current) if (c.full.startsWith('blob:')) URL.revokeObjectURL(c.full); }, []);

  const sigCanvas = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef<{ img: HTMLImageElement; sig: Uint8Array } | null>(null);
  const captured = useRef<Uint8Array | null>(null);
  const pending = useRef<{ sig: Uint8Array; since: number } | null>(null);
  const lastAt = useRef(0);
  const busy = useRef(false);
  const worker = useRef<Promise<OcrWorker> | null>(null);
  const lastText = useRef('');
  const configRef = useRef(config);
  configRef.current = config;

  // Keep a signature of the newest frame.
  useEffect(() => {
    if (!frame || !watching) return;
    let stop = false;
    loadImage(frame).then((img) => {
      if (stop) return;
      sigCanvas.current ??= document.createElement('canvas');
      const sig = signature(img, sigCanvas.current);
      if (sig) latest.current = { img, sig };
    }).catch(() => {});
    return () => { stop = true; };
  }, [frame, watching]);

  // Every 700 ms: has the screen changed and then settled? Then read it.
  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      const cur = latest.current;
      if (!cur || busy.current) return;
      if (captured.current && difference(cur.sig, captured.current) < 0.02) { pending.current = null; return; }
      const p = pending.current;
      if (!p || difference(cur.sig, p.sig) >= 0.01) { pending.current = { sig: cur.sig, since: now }; return; }
      if (now - p.since < 1200 || now - lastAt.current < configRef.current.captureSeconds * 1000) return;
      void read(cur.img, cur.sig);
    }, 700);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  useEffect(() => () => { void worker.current?.then((w) => w.terminate()).catch(() => {}); }, []);

  async function ocr(canvas: HTMLCanvasElement) {
    if (!worker.current) {
      setStatus('loading');
      worker.current = import('tesseract.js').then(({ createWorker }) => createWorker('eng'));
      worker.current.catch(() => { worker.current = null; });
    }
    const w = await worker.current;
    setStatus('reading');
    const { data } = await w.recognize(canvas);
    return data.text;
  }

  async function read(img: HTMLImageElement, sig: Uint8Array) {
    busy.current = true;
    captured.current = sig;
    pending.current = null;
    lastAt.current = Date.now();
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
      const thumb = document.createElement('canvas');
      thumb.width = 240;
      thumb.height = Math.max(1, Math.round((240 * img.naturalHeight) / Math.max(1, img.naturalWidth)));
      thumb.getContext('2d')?.drawImage(img, 0, 0, thumb.width, thumb.height);
      const text = (await ocr(canvas)).trim();
      lastText.current = text;
      // Send a compact JPEG of the settled screen along with the OCR text so
      // the server-side Inspect Buddy question watcher can list screenshots
      // under the session and analyse them even if this browser tab closes.
      let imageDataUrl = '';
      try {
        const small = document.createElement('canvas');
        const scale = Math.min(1, 1280 / Math.max(1, img.naturalWidth));
        small.width = Math.max(1, Math.round(img.naturalWidth * scale));
        small.height = Math.max(1, Math.round(img.naturalHeight * scale));
        small.getContext('2d')?.drawImage(img, 0, 0, small.width, small.height);
        imageDataUrl = small.toDataURL('image/jpeg', 0.6);
      } catch { /* send text only */ }
      const res = await call<CaptureResult>(token, '/capture', { text, image: imageDataUrl || undefined });
      setResult(res);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const full = blob ? URL.createObjectURL(blob) : thumb.toDataURL('image/jpeg', 0.6);
      setCaptures((list) => {
        // Duplicate guard: a settled screen whose OCR text matches the newest
        // capture verbatim is only refreshed in place (new screenshot/time),
        // never added twice to the strip — same rule the watcher applies on
        // the server so the question list stays clean.
        if (list.length && list[0].text.trim() === text.trim()) {
          const [head, ...rest] = list;
          if (full !== head.full && head.full.startsWith('blob:')) URL.revokeObjectURL(head.full);
          return [{ ...head, at: Date.now(), thumb: thumb.toDataURL('image/jpeg', 0.6), full, issues: res.issues }, ...rest];
        }
        const next = [{ at: Date.now(), thumb: thumb.toDataURL('image/jpeg', 0.6), full, text, issues: res.issues }, ...list];
        for (const dropped of next.slice(MAX_KEPT)) if (dropped.full.startsWith('blob:')) URL.revokeObjectURL(dropped.full);
        return next.slice(0, MAX_KEPT);
      });
      setProblem(null);
      setStatus('idle');
      if (configRef.current.autoAssist && res.issues.length) void assist(true);
    } catch (e) {
      setStatus('error');
      setProblem(e instanceof Error ? e.message : 'Could not read the screen.');
    } finally {
      busy.current = false;
    }
  }

  async function assist(auto = false) {
    if (asking) return;
    setAsking(true);
    try {
      const res = await call<CaptureResult & { advice: string; ai: boolean }>(token, '/assist', { text: lastText.current });
      setResult({ issues: res.issues, matches: res.matches });
      if (res.ai) setAdvice({ text: res.advice, at: Date.now() });
    } catch (e) {
      if (!auto) setProblem(e instanceof Error ? e.message : 'Claude could not answer.');
    } finally {
      setAsking(false);
    }
  }

  async function readNow() {
    const cur = latest.current;
    if (!cur || busy.current) return;
    await read(cur.img, cur.sig);
  }

  const statusText = !watching ? 'Paused' : status === 'loading' ? 'Loading the text reader…' : status === 'reading' ? 'Reading the screen…' : 'Watching for screen changes';

  return (
    <aside aria-label="AI Buddy" className="flex max-h-[72dvh] min-h-52 flex-col overflow-hidden rounded-xl border border-foreground/15 bg-card" data-testid="buddy-panel">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-4 py-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">AI Buddy</p>
          <p role="status" className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {(status === 'loading' || status === 'reading') && watching && <Loader2 className="h-3 w-3 animate-spin" />}{statusText}
          </p>
        </div>
        <button type="button" onClick={() => setWatching((w) => !w)} aria-pressed={watching} data-testid="buddy-toggle"
          className="inline-flex items-center gap-1 rounded-lg border border-foreground/15 px-2 py-1 text-xs font-semibold hover:bg-muted">
          {watching ? <><EyeOff className="h-3.5 w-3.5" /> Pause</> : <><Eye className="h-3.5 w-3.5" /> Watch</>}
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
        {problem && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{problem}</p>}

        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">On screen now</h3>
          {!result ? (
            <p className="mt-1 text-xs text-muted-foreground">Nothing read yet. AI Buddy reads the screen a moment after it changes.</p>
          ) : result.issues.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No error messages spotted.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {result.issues.map((i) => (
                <li key={i} className="flex gap-1.5 text-xs"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" /><span className="break-words">{i}</span></li>
              ))}
            </ul>
          )}
        </section>

        {result && result.matches.length > 0 && (
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Knowledge base</h3>
            <ul className="mt-1 space-y-1.5">
              {result.matches.map((m) => (
                <li key={m.id} className="rounded-lg border border-foreground/10">
                  <button type="button" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold">
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-primary" /><span className="flex-1">{m.title}</span>
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open === m.id ? 'rotate-180' : ''}`} />
                  </button>
                  {open === m.id && (
                    <ol className="list-decimal space-y-1 px-2.5 pb-2.5 pl-7 text-xs text-muted-foreground">
                      {m.steps.split('\n').filter(Boolean).map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {config.ai && (
          <section>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Troubleshooting from Claude</h3>
              <button type="button" disabled={asking || !captures.length} onClick={() => void assist()} data-testid="buddy-ask"
                className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                {asking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Suggest a fix
              </button>
            </div>
            {advice ? (
              <div className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/70 px-3 py-2 text-xs leading-relaxed">{advice.text}
                <p className="mt-1.5 text-[10px] text-muted-foreground">For the screen read at {timeFmt(advice.at)}. Check each step before you run it.</p>
              </div>
            ) : <p className="mt-1 text-xs text-muted-foreground">Ask for troubleshooting steps for the latest screen.</p>}
          </section>
        )}

        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Screen changes</h3>
            <button type="button" onClick={() => void readNow()} disabled={!frame || status === 'reading'} className="text-xs font-semibold text-primary disabled:opacity-50">Read now</button>
          </div>
          {captures.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">None yet.</p> : (
            <ul className="mt-1.5 space-y-2">
              {captures.map((c) => (
                <li key={c.at}>
                  <button type="button" onClick={() => setViewing(c.at)} title="View larger" data-testid={`buddy-capture-${c.at}`}
                    className="group flex w-full gap-2 rounded-lg p-1 text-left hover:bg-muted/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                    <img src={c.thumb} alt={`Screen at ${timeFmt(c.at)}`} className="h-12 w-20 shrink-0 cursor-zoom-in rounded border border-foreground/10 object-cover transition group-hover:border-primary" />
                    <div className="min-w-0 text-[11px]">
                      <p className="font-semibold">{timeFmt(c.at)}{c.issues.length ? <span className="ml-1 text-amber-700">· {c.issues.length} problem{c.issues.length === 1 ? '' : 's'}</span> : null}</p>
                      <p className="line-clamp-2 text-muted-foreground">{c.text.split('\n').find((l) => l.trim()) || 'No text found'}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <p className="border-t border-foreground/10 px-4 py-2 text-[10px] text-muted-foreground">
        Screen text is read in this browser and saved with the session record for your support team. Screenshots stay in this browser.
      </p>
      {viewing !== null && <CaptureViewer captures={captures} at={viewing} onChange={setViewing} />}
    </aside>
  );
}

// A screen change at full size, with the text read from it. Arrow keys or
// the buttons move between the kept screens (newest first).
function CaptureViewer({ captures, at, onChange }: { captures: Capture[]; at: number; onChange: (at: number | null) => void }) {
  const i = captures.findIndex((c) => c.at === at);
  const c = captures[i];
  useEffect(() => {
    if (!c) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && i < captures.length - 1) onChange(captures[i + 1].at);
      if (e.key === 'ArrowRight' && i > 0) onChange(captures[i - 1].at);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [c, i, captures, onChange]);
  if (!c) return null;
  const nav = 'inline-flex items-center gap-1 rounded-lg border border-foreground/15 px-2.5 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-40';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onChange(null); }}>
      <DialogContent className="max-h-[95dvh] w-[96vw] max-w-6xl overflow-y-auto" data-testid="buddy-capture-viewer">
        <DialogHeader>
          <DialogTitle>Screen at {timeFmt(c.at)}</DialogTitle>
          <DialogDescription>
            Screen {captures.length - i} of {captures.length} kept in this browser{c.issues.length ? ` · ${c.issues.length} problem${c.issues.length === 1 ? '' : 's'} spotted` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={nav} disabled={i >= captures.length - 1} onClick={() => onChange(captures[i + 1].at)}><ChevronLeft className="h-3.5 w-3.5" /> Older</button>
          <a href={c.full} target="_blank" rel="noreferrer" className="text-xs font-semibold text-primary underline-offset-2 hover:underline">Open full size in a new tab</a>
          <button type="button" className={nav} disabled={i <= 0} onClick={() => onChange(captures[i - 1].at)}>Newer <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
        <img src={c.full} alt={`Remote screen at ${timeFmt(c.at)}`} className="w-full rounded-lg border border-foreground/10 bg-black object-contain" />
        {c.issues.length > 0 && (
          <ul className="space-y-1">
            {c.issues.map((x) => <li key={x} className="flex gap-1.5 text-xs"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />{x}</li>)}
          </ul>
        )}
        <details className="rounded-lg border border-foreground/10 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold">Text read from this screen</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-sans text-xs text-muted-foreground">{c.text || 'No text found.'}</pre>
        </details>
      </DialogContent>
    </Dialog>
  );
}
