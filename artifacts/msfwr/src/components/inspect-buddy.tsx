import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BookOpen, Camera, ClipboardList, Eye, Loader2, Radio, Search, Sparkles, TriangleAlert, Upload, X,
} from 'lucide-react';
import { getAdminOverview } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorText } from '@/lib/auth';

// Admin console → Inspect Buddy.
// A control-room view of every ongoing remote session, with a per-session
// "Question Watcher": the AI engine watches the screen (OCR of live frames),
// detects the start of an exam, captures each question in order, researches
// the answer in the document repository first and online as a fallback, and
// asks the admin to accept or correct the recommendation before it is kept.
// When the exam finishes, a reading material (questions only) and a Q&A
// document are auto-stored in the repository.

type Mode = 'attended' | 'unattended' | 'link';

const MODE_LABEL: Record<Mode, string> = { attended: 'Attended', unattended: 'Unattended', link: 'Remote URL' };

export type WatcherSession = {
  sessionId: string; pcName: string; mode: Mode; company: string; operator: string; startedAt: number;
  viewers: number; captureCount: number; lastSeenText: string;
  // The watcher state is embedded in the sessions payload by the server, so
  // the control room loads with a single request and no per-session queries.
  watcher?: WatcherView | null;
};

export type QuestionState = 'pending' | 'researching' | 'recommended' | 'accepted' | 'corrected';
export type SourceKind = 'repo' | 'online' | 'ai';

export type WatcherQuestion = {
  index: number; at: number; text: string; screenshotUrl: string | null;
  state: QuestionState; answer: string; explanation: string; confidence: number;
  source: SourceKind; sources: string[]; correctedAnswer: string;
};

export type WatcherStatus = 'off' | 'watching' | 'exam-detected' | 'completed';

// One settled screenshot forwarded by the AI Buddy panel (left pane of the
// watcher detail). questionIndex is set once it has been analysed into a
// numbered question (or merged into an existing one — duplicates are
// prevented server-side by text similarity).
export type WatcherShot = {
  id: string; at: number; imageUrl: string | null; text: string; questionIndex: number | null;
};

export type WatcherView = {
  sessionId: string; enabled: boolean; status: WatcherStatus; startedAt: number | null;
  completedAt: number | null; questions: WatcherQuestion[]; documentsStored: string[]; error: string | null;
  lastSeenText?: string; shots?: WatcherShot[]; examTitle?: string; notes?: string;
};

export type RepoDoc = {
  id: string; title: string; category: string; filename: string; bytes: number;
  uploadedBy: string; uploadedAt: number; origin: 'upload' | 'auto';
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, {
      credentials: 'same-origin',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    // Network-level failure (offline, DNS/TLS hiccup, server cold start).
    // Surface it as a normal error object instead of an opaque TypeError.
    throw Object.assign(new Error('Could not reach the relay server. Check your connection and try again.'), { status: 0, data: null });
  }
  if (!res.ok) {
    // A non-JSON body (e.g. an HTML error page from a proxy or a cold-start
    // relay) must not become "Failed to execute 'json'" — read it as text and
    // pass a useful message along.
    const data = res.status === 204 || res.headers.get('content-type')?.includes('json')
      ? await res.json().catch(() => null)
      : { error: (await res.text().catch(() => '')).slice(0, 200) || `Server responded with ${res.status}` };
    throw Object.assign(new Error(String((data as { error?: string })?.error ?? `request failed (${res.status})`)), { status: res.status, data });
  }
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('json');
  if (!isJson) throw Object.assign(new Error('The relay returned an unexpected response (not JSON). It may still be starting up.'), { status: res.status, data: null });
  return (await res.json()) as T;
}
const send = <T,>(path: string, method: string, body?: unknown) => api<T>(path, { method, body: JSON.stringify(body ?? {}) });

const timeOnly = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function fmtDuration(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return '< 1 min';
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

const STATUS_META: Record<WatcherStatus, { label: string; cls: string }> = {
  off: { label: 'Watcher off', cls: 'bg-muted text-muted-foreground' },
  watching: { label: 'Watching screen', cls: 'bg-sky-500/15 text-sky-700' },
  'exam-detected': { label: 'Exam detected — capturing', cls: 'bg-violet-500/15 text-violet-700' },
  completed: { label: 'Completed — stored in repo', cls: 'bg-emerald-500/15 text-emerald-700' },
};

const QSTATE_META: Record<QuestionState, { label: string; cls: string }> = {
  pending: { label: 'Captured', cls: 'bg-muted text-muted-foreground' },
  researching: { label: 'Researching…', cls: 'bg-sky-500/15 text-sky-700' },
  recommended: { label: 'Needs review', cls: 'bg-amber-500/15 text-amber-700' },
  accepted: { label: 'Accepted', cls: 'bg-emerald-500/15 text-emerald-700' },
  corrected: { label: 'Corrected by admin', cls: 'bg-primary/12 text-primary' },
};

const SOURCE_LABEL: Record<SourceKind, string> = { repo: 'Document repository', online: 'Online research', ai: 'AI knowledge' };

// --- Master toggle: rendered at the TOP of the control room page itself ---
// The engine refuses to enable watchers while `enabled` is false, so this
// always-visible switch (with AI + online-research sub-toggles) PATCHes
// /buddy/inspect/settings directly from the control room header. It never
// hides itself behind a successful load — even if settings are already on,
// the admin can turn Inspect Buddy off again from here.

type InspectSettings = { enabled: boolean; ai: boolean; webSearch: boolean; model: string; maxQuestions: number; apiKeySet?: boolean; envKeySet?: boolean; aiReady?: boolean };

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/35'} ${disabled ? 'opacity-50' : ''}`}
      data-testid={`toggle-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function MasterSwitch({ onChanged, onError }: { onChanged: () => void; onError: (msg: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const s = useQuery<InspectSettings>({ queryKey: ['inspect-settings'], queryFn: () => api<InspectSettings>('/buddy/inspect/settings'), refetchInterval: 30_000 });
  const on = !!s.data?.enabled;
  async function patch(body: Partial<InspectSettings>) {
    setBusy(true);
    try { await send('/buddy/inspect/settings', 'PATCH', body); onChanged(); }
    catch (e) { onError(errorText(e, 'Could not change the Inspect Buddy settings.')); }
    finally { setBusy(false); }
  }
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${on ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`} data-testid="inspect-master-switch">
      <div className="flex items-center gap-3">
        <Toggle label="Inspect Buddy" checked={on} disabled={busy || !s.data} onChange={(v) => void patch({ enabled: v })} />
        <div>
          <p className={`text-sm font-bold ${on ? 'text-emerald-800' : 'text-amber-800'}`}>
            {s.data ? (on ? 'Inspect Buddy is ON — question watchers can be enabled per session.' : 'Inspect Buddy is OFF — enable it to start watching sessions.') : 'Loading Inspect Buddy settings…'}
          </p>
          {!on && <p className="mt-0.5 text-xs text-amber-700"><TriangleAlert className="mr-1 inline h-3.5 w-3.5" /> Question watchers cannot be enabled until this switch is on.</p>}
        </div>
      </div>
      {on && s.data && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-foreground/80">
            <Toggle label="Claude AI" checked={!!s.data.ai} disabled={busy} onChange={(v) => void patch({ ai: v })} /> Claude AI engine
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-foreground/80">
            <Toggle label="Online research" checked={!!s.data.webSearch} disabled={busy} onChange={(v) => void patch({ webSearch: v })} /> Online research fallback
          </label>
          {!s.data.apiKeySet && !s.data.envKeySet && s.data.ai && (
            <span className="text-[11px] font-semibold text-amber-700">No Anthropic API key set — add one in settings or set ANTHROPIC_API_KEY on the relay.</span>
          )}
        </div>
      )}
    </div>
  );
}

// --- Control room: list of ongoing sessions with watcher controls ---

type OverviewLive = {
  id: string; name?: string; mode?: Mode; state?: string; ra?: string | null;
  operator?: string; viewers?: number; liveAt?: number; createdAt?: number;
};

function fromOverview(live: OverviewLive[]): WatcherSession[] {
  return (live ?? [])
    .filter((s) => s && s.state !== 'waiting')
    .map((s) => ({
      sessionId: s.id,
      pcName: s.name || '',
      mode: (s.mode || 'attended') as Mode,
      company: '',
      operator: s.operator ?? '',
      startedAt: s.liveAt ?? s.createdAt ?? Date.now(),
      viewers: s.viewers ?? 0,
      captureCount: 0,
      lastSeenText: '',
      watcher: null,
    }));
}

export function InspectBuddyPanel({ onError }: { onError: (msg: string | null) => void }) {
  const qc = useQueryClient();
  const [view, setView] = useState<'list' | 'repo'>('list');
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // Primary source: the dedicated endpoint, which embeds each session's
  // watcher state in one payload. Fallback: /api/admin/overview — the exact
  // table the Sessions tab counts — so even if this relay build predates the
  // buddy routes, the control room still lists ongoing sessions instead of
  // erroring out.
  const list = useQuery<WatcherSession[]>({
    queryKey: ['buddy-sessions'],
    queryFn: async () => {
      try {
        const r = await api<{ sessions: WatcherSession[] }>('/buddy/sessions');
        return r.sessions ?? [];
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 405 || status === 502 || status === 503 || status === 504) {
          const ov = await getAdminOverview();
          return fromOverview((ov.live ?? []) as OverviewLive[]);
        }
        throw e;
      }
    },
    refetchInterval: 10_000,
  });

  useEffect(() => { if (list.error) onError(errorText(list.error, 'Could not load the ongoing sessions.')); }, [list.error, onError]);

  const rows = list.data ?? [];
  const map: Record<string, WatcherView | null> = {};
  for (const r of rows) map[r.sessionId] = r.watcher ?? null;
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter((r) => !needle ||
    [r.pcName, r.company, r.operator].join(' ').toLowerCase().includes(needle)), [rows, needle]);

  const liveWatched = rows.filter((r) => (map[r.sessionId]?.enabled ?? false)).length;
  const exams = rows.filter((r) => { const w = map[r.sessionId]; return w && w.status !== 'off' && w.status !== 'watching'; }).length;
  const pendingReview = rows.reduce((t, r) => t + (map[r.sessionId]?.questions.filter((x) => x.state === 'recommended').length ?? 0), 0);

  async function toggle(sessionId: string, enable: boolean) {
    try {
      await send(`/buddy/watchers/${encodeURIComponent(sessionId)}`, enable ? 'POST' : 'DELETE');
      await qc.invalidateQueries({ queryKey: ['buddy-sessions'] });
    } catch (e) { onError(errorText(e, 'Could not change the watcher.')); }
  }

  if (view === 'repo') return <RepoPanel onBack={() => setView('list')} onError={onError} />;

  return (
    <div className="space-y-4">
      <MasterSwitch onError={onError} onChanged={() => { void qc.invalidateQueries({ queryKey: ['buddy-sessions'] }); void qc.invalidateQueries({ queryKey: ['inspect-settings'] }); }} />
      <div className="rounded-2xl border bg-card/90 p-4 shadow-[0_10px_30px_-24px_hsl(200_32%_13%/0.5)] md:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold"><Radio className="h-4.5 w-4.5 text-primary" /> Control room — ongoing sessions</h2>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setView('repo')} data-testid="button-open-repo"
              className="inline-flex items-center gap-1.5 rounded-xl border border-foreground/15 px-3 py-1.5 text-xs font-semibold hover:bg-muted">
              <BookOpen className="h-3.5 w-3.5" /> Document repository
            </button>
            <button type="button" onClick={() => void qc.invalidateQueries({ queryKey: ['buddy-sessions'] })}
              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
              <RefreshLike /> Refresh
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Ongoing sessions" value={rows.length} />
          <Stat label="Watchers enabled" value={liveWatched} />
          <Stat label="Exams in progress" value={exams} />
          <Stat label="Awaiting your review" value={pendingReview} />
        </div>

        <label className="relative mt-3 block min-w-[200px]">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PC, company or helper" aria-label="Search sessions"
            className="w-full rounded-xl border border-foreground/15 bg-background px-3 py-2 pl-9 text-sm outline-none focus:border-primary" data-testid="input-inspect-search" />
        </label>

        {list.isPending ? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p> : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{rows.length ? 'No session matches this search.' : 'No ongoing sessions right now. Sessions appear here live as soon as a helper connects.'}</p>
        ) : (
          <ul className="mt-3 divide-y divide-foreground/8">
            {filtered.map((r) => {
              const w = map[r.sessionId];
              const st: WatcherStatus = w?.enabled ? w.status : 'off';
              const meta = STATUS_META[st];
              const qs = w?.questions ?? [];
              const reviewed = qs.filter((x) => x.state === 'accepted' || x.state === 'corrected').length;
              return (
                <li key={r.sessionId} className="px-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.pcName || 'Windows PC'}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{MODE_LABEL[r.mode]}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"><Eye className="h-3 w-3" /> Live · {r.viewers} viewer{r.viewers === 1 ? '' : 's'}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`} data-testid={`watcher-status-${r.sessionId}`}>{meta.label}</span>
                    {qs.some((x) => x.state === 'recommended') && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700"><TriangleAlert className="h-3 w-3" /> {qs.filter((x) => x.state === 'recommended').length} to review</span>}
                    <span className="ml-auto text-xs text-muted-foreground">since {timeOnly(r.startedAt)} · {fmtDuration(Date.now() - r.startedAt)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.company || 'Unknown company'}{r.operator && r.operator !== r.company ? ` · ${r.operator}` : ''} · {r.captureCount} screens read</p>
                  {st !== 'off' && (
                    <p className="mt-1 line-clamp-1 text-xs italic text-muted-foreground">Last seen: “{(w?.lastSeenText ?? r.lastSeenText ?? '').slice(0, 140) || '—'}”</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className={`inline-flex items-center gap-2 rounded-xl border border-foreground/15 px-3 py-1.5 text-xs font-semibold ${st === 'off' ? '' : 'border-primary/40 bg-primary/5'}`}>
                      <input type="checkbox" checked={st !== 'off'} onChange={(e) => void toggle(r.sessionId, e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" data-testid={`toggle-watcher-${r.sessionId}`} />
                      Question Watcher
                    </label>
                    {st !== 'off' && (
                      <>
                        <span className="text-xs text-muted-foreground">{qs.length} question{qs.length === 1 ? '' : 's'} captured · {reviewed} reviewed</span>
                        <button type="button" onClick={() => setOpenSession(r.sessionId)} data-testid={`button-open-watcher-${r.sessionId}`}
                          className="inline-flex items-center gap-1 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
                          <ClipboardList className="h-3.5 w-3.5" /> Open watcher
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Enable the Question Watcher on any session: the AI engine then reads every screen in parallel, detects when an exam starts, captures each question in order, researches the answer in the document repository first (online research as fallback) and waits for you to accept or correct it.</p>
      </div>

      {openSession && <WatcherDetail sessionId={openSession} onClose={() => setOpenSession(null)} onError={onError} />}
    </div>
  );
}

function RefreshLike() { return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>; }

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-foreground/10 bg-background/60 px-3 py-2">
      <p className="text-[11px] font-semibold text-muted-foreground">{label}</p>
      <p className="text-xl font-extrabold">{value}</p>
    </div>
  );
}

// --- Per-session watcher detail: ordered questions, review workflow ---

function WatcherDetail({ sessionId, onClose, onError }: { sessionId: string; onClose: () => void; onError: (msg: string | null) => void }) {
  const qc = useQueryClient();
  const w = useQuery({
    queryKey: ['buddy-watcher', sessionId],
    queryFn: () => api<WatcherView & { lastSeenText?: string }>(`/buddy/watchers/${encodeURIComponent(sessionId)}`),
    refetchInterval: 4_000,
  });
  const [busy, setBusy] = useState<number | null>(null);
  const [busyShot, setBusyShot] = useState<string | null>(null);
  const [selectedShot, setSelectedShot] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<WatcherQuestion | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function decide(index: number, action: 'accept' | 'correct', answer?: string) {
    setBusy(index); setMsg(null);
    try {
      await send(`/buddy/watchers/${encodeURIComponent(sessionId)}/questions/${index}/${action}`, 'POST', answer ? { answer } : undefined);
      setMsg(action === 'accept' ? 'Answer accepted.' : 'Correction saved.');
      await qc.invalidateQueries({ queryKey: ['buddy-watcher', sessionId] });
      await qc.invalidateQueries({ queryKey: ['buddy-sessions'] });
    } catch (e) { onError(errorText(e, 'That decision did not go through.')); } finally { setBusy(null); }
  }

  const data = w.data;
  const questions = [...(data?.questions ?? [])].sort((a, b) => a.index - b.index);
  // Newest screenshot first in the left strip: while no exam is detected yet
  // this is exactly what the operator wants to see — the live screen flow.
  const shots = [...(data?.shots ?? [])].sort((a, b) => b.at - a.at);

  // Auto-analysis: as soon as screenshots arrive under the session, every
  // un-analysed one is turned into a numbered question and its answer
  // research starts — no need to press "Analyse" or "Start capturing" for
  // each screen. Duplicate screens merge into the existing question
  // server-side, so re-sending a settled screen never doubles up. Only one
  // shot is sent at a time (busyShot keeps the others waiting for the next
  // poll), and completed watches are left untouched.
  useEffect(() => {
    if (!data || data.status === 'completed' || busyShot) return;
    const pending = [...(data.shots ?? [])].sort((a, b) => a.at - b.at).find((s) => s.questionIndex == null && (s.text || s.imageUrl));
    if (!pending) return;
    void analyseShot(pending.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, busyShot]);

  async function forceExam() {
    setBusy(-1); setMsg(null);
    try {
      await send(`/buddy/watchers/${encodeURIComponent(sessionId)}/force-exam`, 'POST');
      setMsg('Capturing started — every new screen is now read as a question.');
      await qc.invalidateQueries({ queryKey: ['buddy-watcher', sessionId] });
      await qc.invalidateQueries({ queryKey: ['buddy-sessions'] });
    } catch (e) { onError(errorText(e, 'Could not start the capture.')); } finally { setBusy(null); }
  }

  // Analyse one screenshot right now: it becomes (or merges into) a numbered
  // question and AI research for the answer starts immediately.
  async function analyseShot(shotId: string) {
    setBusyShot(shotId); setMsg(null);
    try {
      const q = await send<{ index?: number }>(`/buddy/watchers/${encodeURIComponent(sessionId)}/shots/${encodeURIComponent(shotId)}/analyse`, 'POST');
      setMsg(q?.index ? `Screen analysed — question Q${q.index} is being researched.` : 'Screen analysed.');
      await qc.invalidateQueries({ queryKey: ['buddy-watcher', sessionId] });
      await qc.invalidateQueries({ queryKey: ['buddy-sessions'] });
    } catch (e) { onError(errorText(e, 'Could not analyse that screenshot.')); } finally { setBusyShot(null); }
  }


  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-6xl overflow-y-auto" data-testid="dialog-watcher-detail">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Camera className="h-4.5 w-4.5 text-primary" /> Question Watcher</DialogTitle>
          <DialogDescription>
            Session {sessionId.slice(0, 8)} · {data ? STATUS_META[data.status].label : 'loading…'}
            {data?.startedAt ? ` · started ${dateTime(data.startedAt)}` : ''}
            {data?.completedAt ? ` · finished ${dateTime(data.completedAt)}` : ''}
          </DialogDescription>
        </DialogHeader>

        {w.isPending ? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p> : !data ? (
          <p className="text-sm text-muted-foreground">The watcher could not be loaded.</p>
        ) : (
          <div className="space-y-4">
            {data.error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-700">{data.error}</p>}

            {/* Split view: screenshots under the session on the left,
                numbered questions + AI analysis and answers on the right. */}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
              {/* --- Left pane: screenshot strip (newest first) --- */}
              <section className="lg:max-h-[70dvh] lg:overflow-y-auto lg:pr-1" aria-label="Screenshots" data-testid="watcher-shots-pane">
                <h3 className="sticky top-0 z-10 -mx-1 mb-2 bg-background/95 px-1 py-1 text-xs font-bold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  Screenshots ({shots.length})
                </h3>
                {shots.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-foreground/15 p-4 text-center text-xs text-muted-foreground">
                    No screens have arrived from this session yet. The AI Buddy panel on the remote desktop sends a screenshot with every settled screen it reads.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {shots.map((s, i) => (
                      <li key={s.id} data-testid={`shot-${s.id}`}>
                        <button type="button" onClick={() => setSelectedShot(selectedShot === s.id ? null : s.id)}
                          className={`w-full rounded-xl border p-2 text-left transition-colors ${selectedShot === s.id ? 'border-primary bg-primary/5' : 'border-foreground/12 hover:bg-muted/40'}`}>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="font-bold text-foreground">#{shots.length - i}</span>
                            <span>{timeOnly(s.at)}</span>
                            {s.questionIndex != null && (
                              <span className="ml-auto rounded-full bg-violet-500/15 px-2 py-0.5 font-semibold text-violet-700">Q{s.questionIndex}</span>
                            )}
                          </div>
                          {s.imageUrl ? (
                            <img src={s.imageUrl} alt={`Screen at ${timeOnly(s.at)}`} loading="lazy"
                              className="mt-1.5 w-full rounded-lg border border-foreground/10 object-cover" />
                          ) : (
                            <p className="mt-1.5 line-clamp-3 rounded-lg bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">{s.text || '(no readable text)'}</p>
                          )}
                          {selectedShot === s.id && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {s.imageUrl && <a href={s.imageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"><Camera className="h-3 w-3" /> Open full size</a>}
                              <button type="button" disabled={busyShot === s.id || data.status === 'completed'} data-testid={`button-analyse-${s.id}`}
                                onClick={(e) => { e.stopPropagation(); void analyseShot(s.id); }}
                                className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                                {busyShot === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                {s.questionIndex != null ? 'Re-analyse' : 'Analyse question'}
                              </button>
                            </div>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* --- Right pane: questions, analysis and answers --- */}
              <section aria-label="Questions and answers" data-testid="watcher-questions-pane">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Questions &amp; answers ({questions.length})</h3>
                  {data.examTitle && <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-semibold text-violet-700">{data.examTitle}</span>}
                  {data.status === 'watching' && (
                    <button type="button" disabled={busy === -1} onClick={() => void forceExam()} data-testid="button-force-exam"
                      className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                      {busy === -1 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Start capturing now
                    </button>
                  )}
                </div>

                {questions.length === 0 ? (
                  <div className="py-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      {data.status === 'watching'
                        ? shots.length
                          ? 'Screens are arriving — click “Analyse question” on any screenshot to start the answer research now, or press “Start capturing now” to treat every screen as a question.'
                          : 'Watching the screen… waiting for screenshots from the remote desktop.'
                        : data.status === 'off' ? 'The watcher is off. Turn on the Question Watcher for this session.' : 'No question captured yet.'}
                    </p>
                  </div>
                ) : (
                  // Each question: stem on the left of its card row, AI analysis + answer on the right.
                  <ol className="grid gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                    {questions.map((x) => (
                      <li key={x.index} className="contents" data-testid={`question-${x.index}`}>
                        <div className="rounded-xl border border-foreground/12 bg-background/60 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-foreground/8 px-2 py-0.5 text-[11px] font-bold">Q{x.index}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${QSTATE_META[x.state].cls}`}>{QSTATE_META[x.state].label}</span>
                            <span className="text-[11px] text-muted-foreground">{timeOnly(x.at)}</span>
                            {x.screenshotUrl && <a href={x.screenshotUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"><Camera className="h-3 w-3" /> Screenshot</a>}
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm font-medium">{x.text}</p>
                        </div>
                        <div className="rounded-xl border border-foreground/12 bg-card p-3">
                          {(x.state === 'recommended' || x.state === 'accepted' || x.state === 'corrected') && (
                            <>
                              <p className="flex flex-wrap items-center gap-2">
                                <Sparkles className="h-3.5 w-3.5 text-primary" />
                                <span className="font-bold">{x.state === 'corrected' ? x.correctedAnswer : x.answer}</span>
                                <span className="ml-auto text-[11px] font-semibold text-muted-foreground">{SOURCE_LABEL[x.source]} · {Math.round(x.confidence * 100)}%</span>
                              </p>
                              {x.explanation && <p className="mt-1 text-xs text-muted-foreground">{x.explanation}</p>}
                              {x.sources.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">Sources: {x.sources.join(' · ')}</p>}
                            </>
                          )}
                          {x.state === 'researching' && <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Searching the repository, then online…</p>}
                          {x.state === 'pending' && <p className="text-xs text-muted-foreground">Waiting for research…</p>}

                          {x.state === 'recommended' && (
                            <div className="mt-2 flex gap-2">
                              <button type="button" disabled={busy === x.index} data-testid={`button-accept-${x.index}`}
                                onClick={() => void decide(x.index, 'accept')}
                                className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Accept &amp; continue</button>
                              <button type="button" disabled={busy === x.index} data-testid={`button-correct-${x.index}`}
                                onClick={() => setCorrecting(x)}
                                className="inline-flex items-center gap-1 rounded-xl border border-foreground/15 px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"><X className="h-3 w-3" /> Correct it</button>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            {data.documentsStored.length > 0 && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                <p className="font-bold text-emerald-800">Auto-stored in the repository</p>
                <ul className="mt-1 space-y-0.5 text-xs text-emerald-800/90">{data.documentsStored.map((d) => <li key={d}>• {d}</li>)}</ul>
              </div>
            )}
            {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
          </div>
        )}
        {correcting && <CorrectDialog question={correcting} onClose={() => setCorrecting(null)} onSubmit={(answer) => { setCorrecting(null); void decide(correcting.index, 'correct', answer); }} />}
      </DialogContent>
    </Dialog>
  );
}

function CorrectDialog({ question, onClose, onSubmit }: { question: WatcherQuestion; onClose: () => void; onSubmit: (answer: string) => void }) {
  const [answer, setAnswer] = useState(question.correctedAnswer || question.answer);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Correct the answer to Q{question.index}</DialogTitle>
          <DialogDescription className="line-clamp-3">{question.text}</DialogDescription></DialogHeader>
        <textarea autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4}
          className="w-full rounded-xl border border-foreground/15 bg-background px-3 py-2 text-sm outline-none focus:border-primary" data-testid="input-correction" />
        <DialogFooter>
          <button type="button" onClick={onClose} className="rounded-xl border border-foreground/15 px-3 py-1.5 text-sm font-semibold hover:bg-muted">Cancel</button>
          <button type="button" disabled={!answer.trim()} onClick={() => onSubmit(answer.trim())} data-testid="button-save-correction"
            className="rounded-xl bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">Save correction</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Document repository: categorized uploads + auto-stored materials ---

function RepoPanel({ onBack, onError }: { onBack: () => void; onError: (msg: string | null) => void }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['buddy-repo'], queryFn: () => api<{ documents: RepoDoc[]; categories: string[] }>('/buddy/repo/documents') });
  const [category, setCategory] = useState('General');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [msg, setMsg] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setUploading(true); setMsg(null);
    try {
      const buf = await file.arrayBuffer();
      await api('/buddy/repo/documents', { method: 'POST', body: JSON.stringify({
        category: category.trim() || 'General', title: title.trim() || file.name, filename: file.name, dataBase64: toBase64(buf),
      }) });
      setMsg(`Uploaded “${file.name}” to ${category}.`);
      setFile(null); setTitle('');
      await qc.invalidateQueries({ queryKey: ['buddy-repo'] });
    } catch (e) { onError(errorText(e, 'Upload failed.')); } finally { setUploading(false); }
  }

  const all = docs.data?.documents ?? [];
  const cats = docs.data?.categories ?? [];
  const shown = filter === 'all' ? all : all.filter((d) => d.category === filter);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card/90 p-4 md:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold"><BookOpen className="h-4.5 w-4.5 text-primary" /> Document repository</h2>
          <button type="button" onClick={onBack} data-testid="button-repo-back" className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> Back to control room</button>
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_180px_1fr_auto] sm:items-end">
          <label className="block text-xs font-semibold">Category
            <input list="repo-categories" value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full rounded-xl border border-foreground/15 bg-background px-3 py-2 text-sm outline-none focus:border-primary" data-testid="input-repo-category" />
            <datalist id="repo-categories">{cats.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="block text-xs font-semibold">Title (optional)
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-xl border border-foreground/15 bg-background px-3 py-2 text-sm outline-none focus:border-primary" data-testid="input-repo-title" />
          </label>
          <label className="block text-xs font-semibold">File
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 w-full text-xs" data-testid="input-repo-file" />
          </label>
          <button type="button" disabled={!file || uploading} onClick={() => void upload()} data-testid="button-repo-upload"
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
          </button>
        </div>
        {msg && <p role="status" className="mt-2 text-xs text-muted-foreground">{msg}</p>}
        <p className="mt-2 text-xs text-muted-foreground">The Question Watcher searches these documents first when answering an exam question. Completed exams are also stored here automatically (“Reading material” and “Questions & answers”).</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {['all', ...cats].map((c) => (
            <button key={c} type="button" onClick={() => setFilter(c)} data-testid={`repo-filter-${c}`}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
              {c === 'all' ? 'All categories' : c}
            </button>
          ))}
        </div>

        {docs.isPending ? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p> : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No documents in this category yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-foreground/8">
            {shown.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm" data-testid={`repo-doc-${d.id}`}>
                <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-semibold text-primary">{d.category}</span>
                <span className="font-semibold">{d.title}</span>
                {d.origin === 'auto' && <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-semibold text-violet-700"><Sparkles className="h-3 w-3" /> Auto-stored</span>}
                <span className="ml-auto text-xs text-muted-foreground">{d.filename} · {(d.bytes / 1024).toFixed(0)} KB · {dateTime(d.uploadedAt)} · {d.uploadedBy}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function toBase64(buf: ArrayBuffer) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
