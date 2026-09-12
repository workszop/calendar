import { useState, useEffect, useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import confetti from 'canvas-confetti';
import { Clock, MapPin, Users, Grid, PenLine, Award, Trash2, AlertCircle } from 'lucide-react';
import type { Poll, PollSummary, SlotStatus } from './types';
import { Header } from './components/Header';
import { FinalizedBanner } from './components/FinalizedBanner';
import { HeatmapGrid } from './components/HeatmapGrid';
import { AvailabilityPainter } from './components/AvailabilityPainter';
import { ConsensusPanel } from './components/ConsensusPanel';
import { CreatePollModal } from './components/CreatePollModal';
import { ShareModal } from './components/ShareModal';
import { PollListModal } from './components/PollListModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Toast } from './components/Toast';
import { toDateStr } from './utils/calendar';
import { getStoredGridInterval, getStoredUser, setStoredGridInterval } from './utils/storage';
import type { GridInterval } from './utils/grid';
import { TOAST_MS } from './utils/constants';

// ─── Constants ───

type ActiveTab = 'heatmap' | 'painter' | 'consensus';

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DRAFT_POLL_ID = 'draft';

// Explanatory lead for the blank draft. It is never stored on the poll, so it
// cannot leak into a real poll's description once the draft is persisted.
const DRAFT_LEAD =
  'No poll has been created yet. These days and hours are a sample proposal: answer them to start a poll, or use New Poll to propose your own title, dates and hours.';

// canvas-confetti takes raw colour strings, so these are edulab literals
// (yellow / green / blue / yellow-600 / paper) rather than CSS variables.
const EDULAB_CONFETTI = ['#FFD500', '#00A651', '#1E8FC2', '#F0C800', '#FFFFFF'];

const TABS: { id: ActiveTab; label: string; Icon: typeof Grid }[] = [
  { id: 'heatmap', label: 'Group Heatmap', Icon: Grid },
  { id: 'painter', label: 'Mark My Availability', Icon: PenLine },
  { id: 'consensus', label: 'Top Best Times', Icon: Award },
];

// ─── Helpers ───

// Blank proposition shown when no poll exists yet: next five weekdays, 9-17.
function makeDraftPoll(): Poll {
  const dates: string[] = [];
  const d = new Date();
  while (dates.length < 5) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    // Local weekday and local date string must describe the same day.
    if (day !== 0 && day !== 6) dates.push(toDateStr(d));
  }
  return {
    id: DRAFT_POLL_ID,
    title: 'New meeting',
    description: '',
    durationMinutes: 60,
    timezone: BROWSER_TIMEZONE,
    dates,
    startHour: 9,
    endHour: 17,
    slotInterval: 30,
    creatorName: 'Organizer',
    createdAt: new Date().toISOString(),
    finalizedSlot: null,
    participants: [],
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// The API answers a failure with { error }. Prefer that message over a generic
// one, but never let a non-JSON body turn into a second failure.
async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: unknown } | null)?.error;
    if (typeof message === 'string' && message.trim()) return new Error(message);
  } catch {
    // Empty or non-JSON body: fall through to the generic message.
  }
  return new Error(fallback);
}

export default function App() {
  // ─── State ───
  const [pollsList, setPollsList] = useState<PollSummary[]>([]);
  const [activePoll, setActivePoll] = useState<Poll | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('heatmap');
  const [gridInterval, setGridInterval] = useState<GridInterval>(getStoredGridInterval);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    pollId: string;
    id: string;
    name: string;
  } | null>(null);
  // Remount key for the painter. It changes only when the user genuinely moves
  // to a different poll, never when a draft is persisted mid-save: the painter
  // must stay mounted so its inline error survives a failing /respond.
  const [painterKey, setPainterKey] = useState(0);

  // Filter in heatmap
  const [activeParticipantFilter, setActiveParticipantFilter] = useState<string | null>(null);

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isPollListModalOpen, setIsPollListModalOpen] = useState(false);

  // ─── Refs ───
  const didInit = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const heatmapTabRef = useRef<HTMLButtonElement | null>(null);
  const focusHeatmapTabRef = useRef(false);
  const pollsListRef = useRef<PollSummary[]>([]);
  const listRequestRef = useRef(0);
  const navigationRequestRef = useRef(0);
  const navigationAbortRef = useRef<AbortController | null>(null);
  const activePollIdRef = useRef<string | null>(null);

  // ─── Helpers ───
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      navigationAbortRef.current?.abort();
    };
  }, []);

  // Every navigation gets a monotonically increasing request id. Aborting the
  // old fetch saves work in the browser, while the id check is still required
  // because a mocked or cached fetch may resolve after abort.
  const beginNavigation = useCallback((pollId: string | null) => {
    navigationAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++navigationRequestRef.current;
    navigationAbortRef.current = controller;
    activePollIdRef.current = pollId;
    setPendingDelete(null);
    return { requestId, controller };
  }, []);

  const commitActivePoll = useCallback((nextPoll: Poll) => {
    activePollIdRef.current = nextPoll.id;
    setActivePoll(nextPoll);
  }, []);

  // Single place where the ?poll= query param is written. `push` adds a history
  // entry (a deliberate navigation), `replace` rewrites the current one so Back
  // never lands on a poll the user did not choose.
  const syncPollUrl = useCallback((id: string | null, mode: 'push' | 'replace') => {
    const url = new URL(window.location.href);
    const current = url.searchParams.get('poll');
    if (id === null) {
      if (current === null) return;
      url.searchParams.delete('poll');
    } else {
      if (current === id) return;
      url.searchParams.set('poll', id);
    }
    const next = url.toString();
    if (mode === 'push') window.history.pushState({}, '', next);
    else window.history.replaceState({}, '', next);
  }, []);

  // Fetch all polls list
  const fetchPollsList = useCallback(async (): Promise<PollSummary[]> => {
    const requestId = ++listRequestRef.current;
    try {
      const res = await fetch('/api/polls');
      if (!res.ok) throw await readError(res, 'Failed to fetch polls');
      const data: PollSummary[] = await res.json();
      if (requestId === listRequestRef.current) {
        pollsListRef.current = data;
        setPollsList(data);
      }
      return data;
    } catch (err) {
      // A missing list is a degraded workspace, not a broken one: keep whatever
      // poll is on screen and report it in passing.
      if (requestId === listRequestRef.current) {
        console.error(err);
        showToast(errorMessage(err, 'Could not load the poll list'));
      }
      return [];
    }
  }, [showToast]);

  const showDraftPoll = useCallback(() => {
    beginNavigation(DRAFT_POLL_ID);
    setError(null);
    setActiveParticipantFilter(null);
    commitActivePoll(makeDraftPoll());
    setPainterKey((k) => k + 1);
    setLoading(false);
  }, [beginNavigation, commitActivePoll]);

  // Fetch specific poll. This is the "user moved to another poll" path, so the
  // painter is remounted with fresh state here.
  const fetchPoll = useCallback(
    async (pollId: string, historyMode: 'push' | 'replace' = 'push') => {
      const { requestId, controller } = beginNavigation(pollId);
      setLoading(true);
      setError(null);
      setActiveParticipantFilter(null);
      try {
        const res = await fetch(`/api/polls/${pollId}`, { signal: controller.signal });
        if (!res.ok) {
          throw await readError(res, 'Poll not found');
        }
        const data: Poll = await res.json();
        if (requestId !== navigationRequestRef.current) return;
        commitActivePoll(data);
        setPainterKey((k) => k + 1);
        syncPollUrl(pollId, historyMode);
      } catch (err) {
        if (requestId !== navigationRequestRef.current || controller.signal.aborted) return;
        console.error(err);
        setError(errorMessage(err, 'Failed to load poll'));
      } finally {
        if (requestId === navigationRequestRef.current) setLoading(false);
      }
    },
    [beginNavigation, commitActivePoll, syncPollUrl]
  );

  // What the current URL should show: the poll it names, else the newest poll,
  // else a blank draft. `historyMode` only applies to an explicit ?poll= id;
  // an auto-selected poll always rewrites the entry instead of stacking one,
  // so Back leaves the app rather than showing a phantom draft.
  const resolveInitialPoll = useCallback(
    async (historyMode: 'push' | 'replace', list: PollSummary[]) => {
      const pollParam = new URLSearchParams(window.location.search).get('poll');
      if (pollParam) {
        await fetchPoll(pollParam, historyMode);
        return;
      }
      if (list.length > 0) {
        await fetchPoll(list[0].id, 'replace');
        return;
      }
      showDraftPoll();
    },
    [fetchPoll, showDraftPoll]
  );

  // Initialize: parse URL query or fall back to the first poll.
  // The ref guard keeps StrictMode's double-run from creating two drafts
  // or firing every request twice.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    const init = async () => {
      const list = await fetchPollsList();
      await resolveInitialPoll('push', list);
    };
    void init();
  }, [fetchPollsList, resolveInitialPoll]);

  // Back / forward navigation between polls. The browser already moved the URL,
  // so nothing here pushes another entry.
  useEffect(() => {
    const onPopState = () => {
      void resolveInitialPoll('replace', pollsListRef.current);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [resolveInitialPoll]);

  useEffect(() => {
    if (activeTab !== 'heatmap' || !focusHeatmapTabRef.current) return;
    focusHeatmapTabRef.current = false;
    heatmapTabRef.current?.focus();
  }, [activeTab]);

  // ─── Handlers ───

  // Save participant availability. On the draft poll the poll is created
  // first and shown immediately, so a failing response does not lose it.
  const handleSaveAvailability = async (
    name: string,
    email: string,
    availability: Record<string, SlotStatus>,
    participantId?: string
  ) => {
    if (!activePoll) return;
    const sourcePollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;
    let pollId = activePoll.id;

    if (pollId === DRAFT_POLL_ID) {
      const { id: _draftId, participants: _p, createdAt: _c, ...draftFields } = activePoll;
      const createRes = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draftFields, creatorName: name }),
      });
      if (!createRes.ok) throw await readError(createRes, 'Failed to create poll');
      const createdPoll: Poll = await createRes.json();
      pollId = createdPoll.id;
      // The id changes here, but the painter deliberately keeps its identity so
      // an inline error from the /respond call below can still render. If the
      // user navigated away while creation was in flight, finish the network
      // operation but do not resurrect the created poll in the UI.
      if (
        navigationRequestId === navigationRequestRef.current &&
        activePollIdRef.current === sourcePollId
      ) {
        commitActivePoll(createdPoll);
        setError(null);
        syncPollUrl(createdPoll.id, 'push');
      }
      void fetchPollsList();
    }

    const res = await fetch(`/api/polls/${pollId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        timezone: BROWSER_TIMEZONE,
        availability,
        participantId,
      }),
    });

    if (!res.ok) {
      // The created poll stays on screen; the painter shows this inline.
      throw await readError(res, 'Failed to save response');
    }

    const { poll: updatedPoll } = (await res.json()) as { poll: Poll };
    // The response was persisted even if navigation changed while it was in
    // flight. Keep the list counts current without applying stale detail data
    // to the newly selected poll.
    void fetchPollsList();
    if (
      navigationRequestId !== navigationRequestRef.current ||
      activePollIdRef.current !== pollId
    ) {
      return;
    }
    commitActivePoll(updatedPoll);
    setError(null);
    // Toast first: the painter's own status region unmounts with the tab switch.
    showToast('Availability saved');
    // Switch to heatmap view to see updated group overlay
    focusHeatmapTabRef.current = true;
    setActiveTab('heatmap');
  };

  // Delete participant (confirmed through the dialog)
  const confirmDeleteParticipant = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!activePoll || !target || target.pollId !== activePoll.id) return;
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;

    try {
      const res = await fetch(`/api/polls/${pollId}/respond/${target.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw await readError(res, 'Failed to remove participant');
      const updated: Poll = await res.json();
      void fetchPollsList();
      if (
        navigationRequestId !== navigationRequestRef.current ||
        activePollIdRef.current !== pollId
      ) {
        return;
      }
      commitActivePoll(updated);
      if (activeParticipantFilter === target.id) {
        setActiveParticipantFilter(null);
      }
      showToast(`Removed ${target.name}'s response`);
    } catch (err) {
      showToast(errorMessage(err, 'Error removing response'));
    }
  };

  // Finalize meeting slot
  const handleFinalizeSlot = async (date: string, startTime: string, endTime: string) => {
    // Nothing to lock on an unsaved draft, or on a poll nobody has answered.
    if (
      !activePoll ||
      activePoll.id === DRAFT_POLL_ID ||
      activePoll.finalizedSlot ||
      activePoll.participants.length === 0
    ) {
      return;
    }
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;

    try {
      const res = await fetch(`/api/polls/${pollId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          startTime,
          endTime,
          confirmedBy: getStoredUser().name || activePoll.creatorName || 'Organizer',
        }),
      });

      if (!res.ok) throw await readError(res, 'Failed to lock meeting time');
      const updated: Poll = await res.json();
      void fetchPollsList();
      if (
        navigationRequestId !== navigationRequestRef.current ||
        activePollIdRef.current !== pollId
      ) {
        return;
      }
      commitActivePoll(updated);
      showToast('Meeting time locked');

      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: EDULAB_CONFETTI,
      });
    } catch (err) {
      showToast(errorMessage(err, 'Error locking time'));
    }
  };

  // Reset finalized meeting
  const handleResetFinalized = async (): Promise<void> => {
    if (!activePoll) return;
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;
    try {
      const res = await fetch(`/api/polls/${pollId}/reset`, { method: 'POST' });
      if (!res.ok) throw await readError(res, 'Failed to reset finalized time');
      const updated: Poll = await res.json();
      void fetchPollsList();
      if (
        navigationRequestId !== navigationRequestRef.current ||
        activePollIdRef.current !== pollId
      ) {
        return;
      }
      commitActivePoll(updated);
      showToast('Voting re-opened');
    } catch (err) {
      showToast(errorMessage(err, 'Error resetting time'));
    }
  };

  // Create new poll
  const handleCreatePoll = async (pollData: Partial<Poll>) => {
    const sourcePollId = activePollIdRef.current;
    const navigationRequestId = navigationRequestRef.current;
    const res = await fetch('/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pollData),
    });
    if (!res.ok) throw await readError(res, 'Failed to create poll');
    const newPoll: Poll = await res.json();
    // The server-side create succeeded even if the user navigated away while
    // it was pending. Refresh the list unconditionally so the new poll remains
    // discoverable without allowing its detail response to resurrect the view.
    void fetchPollsList();
    if (
      navigationRequestId !== navigationRequestRef.current ||
      activePollIdRef.current !== sourcePollId
    ) {
      return;
    }
    commitActivePoll(newPoll);
    setError(null);
    setActiveParticipantFilter(null);
    // A different poll entirely, so the painter starts blank.
    setPainterKey((k) => k + 1);
    syncPollUrl(newPoll.id, 'push');
    // Prompt creator to fill their availability immediately
    setActiveTab('painter');
  };

  const handleTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    e.preventDefault();
    const current = TABS.findIndex((t) => t.id === activeTab);
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else next = TABS.length - 1;

    const nextTab = TABS[next];
    setActiveTab(nextTab.id);
    const btn = tablistRef.current?.querySelector<HTMLButtonElement>(`#tab-${nextTab.id}-btn`);
    btn?.focus();
  };

  // ─── Render ───
  const poll = activePoll;
  // A time can only be locked on a saved poll that somebody has answered.
  const canFinalize =
    poll !== null &&
    poll.id !== DRAFT_POLL_ID &&
    !poll.finalizedSlot &&
    poll.participants.length > 0;

  return (
    <div
      className="min-h-screen bg-white text-stone-900 flex flex-col font-sans"
      data-active-poll-id={poll?.id ?? ''}
      data-loading={loading ? 'true' : 'false'}
    >
      {/* Top Navigation */}
      <Header
        poll={poll && poll.id !== DRAFT_POLL_ID ? poll : null}
        onOpenNewPoll={() => setIsCreateModalOpen(true)}
        onOpenShare={() => setIsShareModalOpen(true)}
        onOpenPollsList={() => setIsPollListModalOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-[1100px] w-full mx-auto px-4 sm:px-6 lg:px-[30px] pt-8 pb-16">
        {loading ? (
          <div
            role="status"
            aria-labelledby="loading-caption"
            className="py-20 flex flex-col items-center justify-center space-y-3"
          >
            <div className="w-10 h-10 border-3 border-yellow-500 border-t-transparent rounded-full animate-spin" />
            <p id="loading-caption" className="text-stone-500 text-xs font-medium">
              Loading meeting poll...
            </p>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="bg-red-500 text-white rounded-2xl p-8 text-center max-w-md mx-auto my-12"
          >
            <AlertCircle className="w-10 h-10 mx-auto mb-2" />
            <h3 className="text-base font-bold text-white">Poll Error</h3>
            <p className="text-xs text-white/90 mt-1">{error}</p>
            <button
              onClick={() => {
                setError(null);
                if (pollsList.length > 0) {
                  void fetchPoll(pollsList[0].id);
                } else {
                  // Seed the draft too, so cancelling the modal is not a blank page.
                  showDraftPoll();
                  setIsCreateModalOpen(true);
                }
              }}
              className="mt-4 px-4 py-2 bg-white text-stone-900 text-xs font-semibold rounded-full transition-colors hover:bg-stone-100"
            >
              {pollsList.length > 0 ? 'Open the latest poll' : 'Start a new poll'}
            </button>
          </div>
        ) : poll ? (
          <div className="space-y-6">
            {/* Finalized Banner if locked */}
            <FinalizedBanner poll={poll} onResetFinalized={handleResetFinalized} />

            {/* Page header: solid-ink title + full-width lead */}
            <header className="text-center space-y-3 pb-2">
              <h1 className="app-title">{poll.title}</h1>
              {poll.id === DRAFT_POLL_ID ? (
                <p className="edu-lead">{DRAFT_LEAD}</p>
              ) : (
                poll.description && <p className="edu-lead">{poll.description}</p>
              )}
            </header>

            {/* Poll Meta & Context Bar */}
            <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-stone-600">
                  <span className="inline-flex items-center gap-1.5 bg-stone-100 px-2.5 py-1 rounded-lg">
                    <Clock className="w-3.5 h-3.5 text-stone-500" />
                    {poll.durationMinutes} Minutes Duration
                  </span>

                  {poll.location && (
                    <span className="inline-flex items-center gap-1.5 bg-stone-100 px-2.5 py-1 rounded-lg">
                      <MapPin className="w-3.5 h-3.5 text-stone-500" />
                      {poll.location}
                    </span>
                  )}

                  <span className="inline-flex items-center gap-1.5 bg-stone-100 px-2.5 py-1 rounded-lg">
                    <Users className="w-3.5 h-3.5 text-stone-500" />
                    {poll.participants.length} Participant
                    {poll.participants.length === 1 ? '' : 's'} responded
                  </span>

                  <span className="text-stone-500">Organized by {poll.creatorName}</span>
                </div>
              </div>

              {/* View Mode Tabs */}
              <div
                ref={tablistRef}
                role="tablist"
                aria-label="Workspace view"
                onKeyDown={handleTabKeyDown}
                className="flex items-center bg-stone-50 p-1 rounded-full shrink-0 self-start md:self-auto"
              >
                {TABS.map(({ id, label, Icon }) => {
                  const selected = activeTab === id;
                  return (
                    <button
                      key={id}
                      id={`tab-${id}-btn`}
                      ref={id === 'heatmap' ? heatmapTabRef : undefined}
                      role="tab"
                      type="button"
                      aria-selected={selected}
                      aria-controls={`tabpanel-${id}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActiveTab(id)}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-full transition-colors ${
                        selected
                          ? 'bg-yellow-500 text-yellow-950'
                          : 'text-stone-600 hover:text-stone-900'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Active Workspace View */}
            {activeTab !== 'consensus' && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <fieldset className="flex items-center gap-2" data-grid-interval={gridInterval}>
                  <legend className="sr-only">Grid time slots</legend>
                  <span className="text-xs font-semibold text-stone-600 mr-1" aria-hidden="true">Grid cells</span>
                  {([30, 60] as const).map((interval) => (
                    <label key={interval} className="cursor-pointer">
                      <input
                        type="radio"
                        name="grid-interval"
                        value={interval}
                        checked={gridInterval === interval}
                        onChange={() => {
                          setGridInterval(interval);
                          setStoredGridInterval(interval);
                        }}
                        className="peer sr-only"
                      />
                      <span className="block px-3.5 py-1.5 rounded-full border border-stone-200 bg-white text-stone-700 text-xs font-bold peer-checked:bg-yellow-500 peer-checked:border-yellow-500 peer-checked:text-yellow-950 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-stone-900">
                        {interval === 30 ? '30 min' : '1 hour'}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <p role="status" className="text-xs text-stone-500">
                  {gridInterval === 60 ? 'Hourly view. Mixed cells contain different answers.' : 'Half-hour view.'} Meeting duration is unchanged.
                </p>
              </div>
            )}

            {activeTab === 'heatmap' && (
              <div role="tabpanel" id="tabpanel-heatmap" aria-labelledby="tab-heatmap-btn">
                <HeatmapGrid
                  poll={poll}
                  gridInterval={gridInterval}
                  onFinalizeSlot={canFinalize ? handleFinalizeSlot : undefined}
                  activeParticipantFilter={activeParticipantFilter}
                  onSelectParticipantFilter={setActiveParticipantFilter}
                />
              </div>
            )}

            {activeTab === 'painter' && (
              <div role="tabpanel" id="tabpanel-painter" aria-labelledby="tab-painter-btn">
                <AvailabilityPainter
                  key={painterKey}
                  poll={poll}
                  gridInterval={gridInterval}
                  onSaveAvailability={handleSaveAvailability}
                  onCancel={() => setActiveTab('heatmap')}
                />
              </div>
            )}

            {activeTab === 'consensus' && (
              <div role="tabpanel" id="tabpanel-consensus" aria-labelledby="tab-consensus-btn">
                <ConsensusPanel
                  poll={poll}
                  onFinalizeSlot={canFinalize ? handleFinalizeSlot : undefined}
                />
              </div>
            )}

            {/* Participants Summary & Management List */}
            {poll.participants.length > 0 && (
              <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-stone-700 uppercase tracking-wider font-mono flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-stone-500" />
                    Responded Participants ({poll.participants.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setActiveTab('painter')}
                    className="text-xs font-bold text-stone-900 hover:underline"
                  >
                    + Add or Update Your Times
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  {poll.participants.map((p) => {
                    const availableSlotsCount = Object.values(p.availability).filter(
                      (s) => s === 'available' || s === 'preferred'
                    ).length;

                    return (
                      <div
                        key={p.id}
                        className="p-3 bg-stone-50 border border-stone-200 rounded-xl flex items-center justify-between gap-2"
                      >
                        <div className="space-y-0.5 overflow-hidden">
                          <div className="text-xs font-bold text-stone-900 truncate">{p.name}</div>
                          <div className="text-[11px] text-stone-500">
                            {availableSlotsCount} slots available
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setPendingDelete({ pollId: poll.id, id: p.id, name: p.name })}
                          aria-label={`Remove ${p.name}'s response`}
                          className="p-1 rounded text-stone-400 hover:text-stone-900 hover:bg-stone-200/60 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </main>

      {/* Modals */}
      <CreatePollModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreatePoll={handleCreatePoll}
        defaultTimezone={BROWSER_TIMEZONE}
      />

      {poll && poll.id !== DRAFT_POLL_ID && (
        <ShareModal
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          poll={poll}
        />
      )}

      <PollListModal
        isOpen={isPollListModalOpen}
        onClose={() => setIsPollListModalOpen(false)}
        polls={pollsList}
        activePollId={poll?.id || null}
        onSelectPoll={(id) => void fetchPoll(id)}
        onOpenNewPoll={() => setIsCreateModalOpen(true)}
      />

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Remove response?"
        message={
          pendingDelete
            ? `${pendingDelete.name}'s availability will be deleted from this poll. This cannot be undone.`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => void confirmDeleteParticipant()}
        onCancel={() => setPendingDelete(null)}
      />

      <Toast message={toast} />
    </div>
  );
}
