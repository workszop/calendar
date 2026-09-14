import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import confetti from 'canvas-confetti';
import { AlertCircle, Award, CalendarPlus, Clock, Grid, MapPin, PenLine, Trash2, Users } from 'lucide-react';
import type { Poll, PollSummary, SlotStatus } from './types';
import { Header } from './components/Header';
import { HomePage } from './components/HomePage';
import { FinalizedBanner } from './components/FinalizedBanner';
import { HeatmapGrid } from './components/HeatmapGrid';
import { AvailabilityPainter } from './components/AvailabilityPainter';
import { ConsensusPanel } from './components/ConsensusPanel';
import { CreatePollPage } from './components/CreatePollPage';
import { ShareModal } from './components/ShareModal';
import { ExtendPollModal } from './components/ExtendPollModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Toast } from './components/Toast';
import { getStoredGridInterval, getStoredUser, setStoredGridInterval } from './utils/storage';
import type { GridInterval } from './utils/grid';
import { TOAST_MS } from './utils/constants';

// ─── Constants ───

type ActiveTab = 'overview' | 'answer';
type AppScreen = 'home' | 'workspace' | 'create' | 'created';
type AppRoute =
  | { kind: 'home' }
  | { kind: 'poll'; id: string }
  | { kind: 'create' }
  | { kind: 'created'; id: string };

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const EDULAB_CONFETTI = ['#FFD500', '#00A651', '#1E8FC2', '#F0C800', '#FFFFFF'];
const TABS: { id: ActiveTab; label: string; Icon: typeof Grid }[] = [
  { id: 'overview', label: 'Group overview', Icon: Grid },
  { id: 'answer', label: 'My answer', Icon: PenLine },
];

// ─── Helpers ───

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: unknown } | null)?.error;
    if (typeof message === 'string' && message.trim()) return new Error(message);
  } catch {
    // Empty or non-JSON body: use the generic message.
  }
  return new Error(fallback);
}

// ─── Component ───

export default function App() {
  // ─── State ───
  const [pollsList, setPollsList] = useState<PollSummary[]>([]);
  const [activePoll, setActivePoll] = useState<Poll | null>(null);
  const [screen, setScreen] = useState<AppScreen>('home');
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [gridInterval, setGridInterval] = useState<GridInterval>(getStoredGridInterval);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [createdPoll, setCreatedPoll] = useState<Poll | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [shareReadyCopied, setShareReadyCopied] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    pollId: string;
    id: string;
    name: string;
  } | null>(null);
  const [pendingPollDelete, setPendingPollDelete] = useState<PollSummary | null>(null);
  const [painterKey, setPainterKey] = useState(0);
  const [activeParticipantFilter, setActiveParticipantFilter] = useState<string | null>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isExtendModalOpen, setIsExtendModalOpen] = useState(false);

  // ─── Refs ───
  const didInit = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const overviewTabRef = useRef<HTMLButtonElement | null>(null);
  const focusOverviewTabRef = useRef(false);
  const pollsListRef = useRef<PollSummary[]>([]);
  const listRequestRef = useRef(0);
  const navigationRequestRef = useRef(0);
  const navigationAbortRef = useRef<AbortController | null>(null);
  const activePollIdRef = useRef<string | null>(null);
  const requestedPollIdRef = useRef<string | null>(null);
  const isCreatingRef = useRef(false);
  const createRouteRef = useRef<string | null>(null);

  // ─── Async navigation ───

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
  // old fetch saves work while the id check remains safe with mocked responses.
  const beginNavigation = useCallback((pollId: string | null) => {
    navigationAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++navigationRequestRef.current;
    navigationAbortRef.current = controller;
    activePollIdRef.current = pollId;
    requestedPollIdRef.current = pollId;
    setPendingDelete(null);
    setPendingPollDelete(null);
    setIsShareModalOpen(false);
    setIsExtendModalOpen(false);
    return { requestId, controller };
  }, []);

  const commitActivePoll = useCallback((nextPoll: Poll) => {
    activePollIdRef.current = nextPoll.id;
    setActivePoll(nextPoll);
    setScreen('workspace');
  }, []);

  // Single place where application routes are written. Bare root is the home
  // list; details are addressed by ?poll= and the transient success route by
  // ?created=.
  const syncRoute = useCallback((route: AppRoute, mode: 'push' | 'replace') => {
    const url = new URL(window.location.href);
    const currentPoll = url.searchParams.get('poll');
    const currentCreate = url.searchParams.get('create');
    const currentCreated = url.searchParams.get('created');
    const nextPoll = route.kind === 'poll' ? route.id : null;
    const nextCreate = route.kind === 'create' ? '1' : null;
    const nextCreated = route.kind === 'created' ? route.id : null;
    if (currentPoll === nextPoll && currentCreate === nextCreate && currentCreated === nextCreated) {
      return;
    }
    url.searchParams.delete('poll');
    url.searchParams.delete('create');
    url.searchParams.delete('created');
    if (nextPoll) url.searchParams.set('poll', nextPoll);
    if (nextCreate) url.searchParams.set('create', nextCreate);
    if (nextCreated) url.searchParams.set('created', nextCreated);
    const next = url.toString();
    if (mode === 'push') window.history.pushState({}, '', next);
    else window.history.replaceState({}, '', next);
  }, []);

  const fetchPollsList = useCallback(async (): Promise<PollSummary[]> => {
    const requestId = ++listRequestRef.current;
    try {
      const res = await fetch('/api/polls');
      if (!res.ok) throw await readError(res, 'Failed to fetch polls');
      const data: PollSummary[] = await res.json();
      if (requestId === listRequestRef.current) {
        pollsListRef.current = data;
        setPollsList(data);
        setListError(null);
      }
      return data;
    } catch (err) {
      if (requestId === listRequestRef.current) {
        const message = errorMessage(err, 'Could not load the poll list');
        setListError(message);
        showToast(message);
      }
      return [];
    }
  }, [showToast]);

  const fetchPoll = useCallback(
    async (pollId: string, historyMode: 'push' | 'replace' = 'push') => {
      const { requestId, controller } = beginNavigation(pollId);
      setLoading(true);
      setError(null);
      setActiveParticipantFilter(null);
      setActivePoll(null);
      setScreen('workspace');
      try {
        const res = await fetch(`/api/polls/${pollId}`, { signal: controller.signal });
        if (!res.ok) throw await readError(res, 'Poll not found');
        const data: Poll = await res.json();
        if (requestId !== navigationRequestRef.current) return;
        commitActivePoll(data);
        setPainterKey((key) => key + 1);
        syncRoute({ kind: 'poll', id: pollId }, historyMode);
      } catch (err) {
        if (requestId !== navigationRequestRef.current || controller.signal.aborted) return;
        setError(errorMessage(err, 'Failed to load poll'));
      } finally {
        if (requestId === navigationRequestRef.current) setLoading(false);
      }
    },
    [beginNavigation, commitActivePoll, syncRoute]
  );

  // Root never chooses an arbitrary poll. A shared poll link intentionally
  // opens the answer tab, while Back/Forward with no query returns to home.
  const resolveInitialRoute = useCallback(
    async (historyMode: 'push' | 'replace') => {
      const params = new URLSearchParams(window.location.search);
      const pollParam = params.get('poll');
      if (pollParam) {
        setActiveTab('answer');
        await fetchPoll(pollParam, historyMode);
        return;
      }
      if (params.get('create') === '1') {
        beginNavigation(null);
        setActivePoll(null);
        setCreatedPoll(null);
        setError(null);
        setActiveTab('overview');
        setScreen('create');
        setLoading(false);
        createRouteRef.current = `${window.location.pathname}${window.location.search}`;
        return;
      }
      const createdId = params.get('created');
      if (createdId && createdPoll?.id === createdId) {
        beginNavigation(null);
        setActivePoll(null);
        setScreen('created');
        setLoading(false);
        return;
      }
      if (createdId) syncRoute({ kind: 'home' }, 'replace');
      beginNavigation(null);
      setActivePoll(null);
      setCreatedPoll(null);
      setError(null);
      setActiveTab('overview');
      setActiveParticipantFilter(null);
      setScreen('home');
      setLoading(false);
    },
    [beginNavigation, createdPoll, fetchPoll, syncRoute]
  );

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const init = async () => {
      await fetchPollsList();
      await resolveInitialRoute('replace');
    };
    void init();
  }, [fetchPollsList, resolveInitialRoute]);

  useEffect(() => {
    const onPopState = () => {
      if (isCreatingRef.current) {
        const route = createRouteRef.current;
        if (route) window.history.pushState({}, '', route);
        showToast('Finish creating the poll before leaving this page');
        return;
      }
      void resolveInitialRoute('replace');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [resolveInitialRoute, showToast]);

  const goHome = useCallback(
    async (historyMode: 'push' | 'replace' = 'push') => {
      if (isCreatingRef.current) {
        showToast('Finish creating the poll before leaving this page');
        return;
      }
      beginNavigation(null);
      setActiveTab('overview');
      setActivePoll(null);
      setCreatedPoll(null);
      setError(null);
      setActiveParticipantFilter(null);
      setScreen('home');
      setLoading(false);
      syncRoute({ kind: 'home' }, historyMode);
      await fetchPollsList();
    },
    [beginNavigation, fetchPollsList, showToast, syncRoute]
  );

  useEffect(() => {
    if (activeTab !== 'overview' || !focusOverviewTabRef.current) return;
    focusOverviewTabRef.current = false;
    overviewTabRef.current?.focus();
  }, [activeTab]);

  // ─── Poll operations ───

  const handleSaveAvailability = async (
    name: string,
    email: string,
    availability: Record<string, SlotStatus>,
    participantId?: string
  ) => {
    if (!activePoll) return;
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;
    const res = await fetch(`/api/polls/${pollId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, timezone: BROWSER_TIMEZONE, availability, participantId }),
    });
    if (!res.ok) throw await readError(res, 'Failed to save response');
    const { poll: updatedPoll } = (await res.json()) as { poll: Poll };
    void fetchPollsList();
    if (navigationRequestId !== navigationRequestRef.current || activePollIdRef.current !== pollId) return;
    commitActivePoll(updatedPoll);
    setError(null);
    showToast('Availability saved');
    focusOverviewTabRef.current = true;
    setActiveTab('overview');
  };

  const confirmDeleteParticipant = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!activePoll || !target || target.pollId !== activePoll.id) return;
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;
    try {
      const res = await fetch(`/api/polls/${pollId}/respond/${target.id}`, { method: 'DELETE' });
      if (!res.ok) throw await readError(res, 'Failed to remove participant');
      const updated: Poll = await res.json();
      void fetchPollsList();
      if (navigationRequestId !== navigationRequestRef.current || activePollIdRef.current !== pollId) return;
      commitActivePoll(updated);
      if (activeParticipantFilter === target.id) setActiveParticipantFilter(null);
      showToast(`Removed ${target.name}'s response`);
    } catch (err) {
      showToast(errorMessage(err, 'Error removing response'));
    }
  };

  const confirmDeletePoll = async () => {
    const target = pendingPollDelete;
    setPendingPollDelete(null);
    if (!target) return;
    try {
      const res = await fetch(`/api/polls/${target.id}`, { method: 'DELETE' });
      if (!res.ok) throw await readError(res, 'Failed to delete poll');
      await fetchPollsList();
      showToast(`Deleted "${target.title}"`);
      if (activePollIdRef.current === target.id) await goHome('replace');
    } catch (err) {
      showToast(errorMessage(err, 'Error deleting poll'));
    }
  };

  const handleAddDates = async (dates: string[], proposedSlots: Record<string, string[]>) => {
    if (!activePoll) return;
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;
    const res = await fetch(`/api/polls/${pollId}/dates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates, proposedSlots }),
    });
    if (!res.ok) throw await readError(res, 'Failed to add dates');
    const updated: Poll = await res.json();
    void fetchPollsList();
    if (navigationRequestId !== navigationRequestRef.current || activePollIdRef.current !== pollId) return;
    commitActivePoll(updated);
    showToast(dates.length === 1 ? 'Added 1 date' : `Added ${dates.length} dates`);
  };

  const handleFinalizeSlot = async (date: string, startTime: string, endTime: string) => {
    if (!activePoll || activePoll.finalizedSlot || activePoll.participants.length === 0) return;
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
      if (navigationRequestId !== navigationRequestRef.current || activePollIdRef.current !== pollId) return;
      commitActivePoll(updated);
      showToast('Meeting time locked');
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 }, colors: EDULAB_CONFETTI });
    } catch (err) {
      showToast(errorMessage(err, 'Error locking time'));
    }
  };

  const handleResetFinalized = async (): Promise<void> => {
    if (!activePoll) return;
    const pollId = activePoll.id;
    const navigationRequestId = navigationRequestRef.current;
    try {
      const res = await fetch(`/api/polls/${pollId}/reset`, { method: 'POST' });
      if (!res.ok) throw await readError(res, 'Failed to reset finalized time');
      const updated: Poll = await res.json();
      void fetchPollsList();
      if (navigationRequestId !== navigationRequestRef.current || activePollIdRef.current !== pollId) return;
      commitActivePoll(updated);
      showToast('Voting re-opened');
    } catch (err) {
      showToast(errorMessage(err, 'Error resetting time'));
    }
  };

  // ─── Creation and route controls ───

  const handleCreatePoll = async (pollData: Partial<Poll>) => {
    const navigationRequestId = navigationRequestRef.current;
    try {
      const res = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pollData),
      });
      if (!res.ok) throw await readError(res, 'Failed to create poll');
      const newPoll: Poll = await res.json();
      void fetchPollsList();
      // A successful POST remains discoverable even if the user navigated away,
      // but stale detail must never replace the current screen.
      if (navigationRequestId !== navigationRequestRef.current || screen !== 'create') return;
      setCreatedPoll(newPoll);
      setActivePoll(null);
      setActiveParticipantFilter(null);
      setShareReadyCopied(false);
      setScreen('created');
      setLoading(false);
      syncRoute({ kind: 'created', id: newPoll.id }, 'replace');
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
    }
  };

  const openCreatePoll = useCallback(() => {
    if (isCreatingRef.current) {
      showToast('Finish creating the poll before leaving this page');
      return;
    }
    beginNavigation(null);
    setActivePoll(null);
    setCreatedPoll(null);
    setError(null);
    setActiveTab('overview');
    setActiveParticipantFilter(null);
    setShareReadyCopied(false);
    setScreen('create');
    setLoading(false);
    syncRoute({ kind: 'create' }, 'push');
    createRouteRef.current = `${window.location.pathname}${window.location.search}`;
  }, [beginNavigation, showToast, syncRoute]);

  const handleCreateBusyChange = useCallback((busy: boolean) => {
    isCreatingRef.current = busy;
    setIsCreating(busy);
    if (busy) createRouteRef.current = `${window.location.pathname}${window.location.search}`;
  }, []);

  const makeSummaryFromPoll = useCallback((source: Poll): PollSummary => ({
    id: source.id,
    title: source.title,
    description: source.description,
    location: source.location,
    durationMinutes: source.durationMinutes,
    timezone: source.timezone,
    dates: source.dates,
    creatorName: source.creatorName,
    createdAt: source.createdAt,
    finalizedSlot: source.finalizedSlot,
    participantsCount: source.participants.length,
  }), []);

  const handleDeleteCurrentPoll = useCallback(() => {
    if (!activePoll) return;
    setPendingPollDelete(
      pollsList.find((item) => item.id === activePoll.id) ?? makeSummaryFromPoll(activePoll)
    );
  }, [activePoll, makeSummaryFromPoll, pollsList]);

  const handleCopyShareReadyLink = useCallback(async () => {
    if (!createdPoll) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}?poll=${createdPoll.id}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareReadyCopied(true);
      showToast('Poll link copied');
    } catch {
      (document.getElementById('share-ready-link') as HTMLInputElement | null)?.select();
      showToast('Copy unavailable - the link is selected');
    }
  }, [createdPoll, showToast]);

  const openCreatedPoll = useCallback(() => {
    if (!createdPoll) return;
    const id = createdPoll.id;
    setShareReadyCopied(false);
    void fetchPoll(id, 'push');
  }, [createdPoll, fetchPoll]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = TABS.findIndex((tab) => tab.id === activeTab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else next = TABS.length - 1;
    const nextTab = TABS[next];
    setActiveTab(nextTab.id);
    tablistRef.current?.querySelector<HTMLButtonElement>(`#tab-${nextTab.id}-btn`)?.focus();
  };

  // ─── Render ───

  const poll = activePoll;
  const canFinalize = poll !== null && !poll.finalizedSlot && poll.participants.length > 0;
  const shareReadyUrl = createdPoll
    ? `${window.location.origin}${window.location.pathname}?poll=${createdPoll.id}`
    : '';

  const workspace = poll && (
    <section className="d-shell-workspace" data-screen="workspace" data-selection={activeTab}>
      <FinalizedBanner poll={poll} onResetFinalized={handleResetFinalized} />

      <header className="d-shell-page-head">
        <div>
          <p className="d-shell-kicker">Meeting workspace</p>
          <h1 className="app-title">{poll.title}</h1>
          {poll.description && <p className="edu-lead">{poll.description}</p>}
        </div>
        <div className="d-shell-poll-meta" aria-label="Meeting details">
          <span><Clock aria-hidden="true" />{poll.durationMinutes} min</span>
          {poll.location && <span><MapPin aria-hidden="true" />{poll.location}</span>}
          <span><Users aria-hidden="true" />{poll.participants.length} {poll.participants.length === 1 ? 'response' : 'responses'}</span>
          {!poll.finalizedSlot && (
            <button
              type="button"
              id="add-dates-button"
              className="edu-btn-secondary d-shell-add-dates"
              onClick={() => setIsExtendModalOpen(true)}
            >
              <CalendarPlus aria-hidden="true" />
              Add dates
            </button>
          )}
        </div>
      </header>

      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Workspace view"
        className="d-shell-tabs"
        onKeyDown={handleTabKeyDown}
      >
        {TABS.map(({ id, label, Icon }) => {
          const selected = activeTab === id;
          return (
            <button
              key={id}
              id={`tab-${id}-btn`}
              ref={id === 'overview' ? overviewTabRef : undefined}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`tabpanel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(id)}
              className={selected ? 'is-selected' : ''}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="d-shell-disclosure-stack">
        <details className="d-shell-disclosure">
          <summary>Calendar settings</summary>
          <div className="d-shell-disclosure-body">
            <fieldset className="d-shell-grid-settings" data-grid-interval={gridInterval}>
              <legend>Grid cells</legend>
              {([30, 60] as const).map((interval) => (
                <label key={interval}>
                  <input
                    type="radio"
                    name="grid-interval"
                    value={interval}
                    checked={gridInterval === interval}
                    onChange={() => {
                      setGridInterval(interval);
                      setStoredGridInterval(interval);
                    }}
                  />
                  <span>{interval === 30 ? '30 min' : '1 hour'}</span>
                </label>
              ))}
            </fieldset>
            <p role="status">
              {gridInterval === 60
                ? 'Hourly view. Mixed cells contain different answers.'
                : 'Half-hour view.'}{' '}
              Meeting duration is unchanged.
            </p>
          </div>
        </details>
      </div>

      {activeTab === 'overview' ? (
        <div role="tabpanel" id="tabpanel-overview" aria-labelledby="tab-overview-btn">
          <HeatmapGrid
            poll={poll}
            gridInterval={gridInterval}
            onFinalizeSlot={canFinalize ? handleFinalizeSlot : undefined}
            activeParticipantFilter={activeParticipantFilter}
            onSelectParticipantFilter={setActiveParticipantFilter}
          />
          <details className="d-shell-disclosure d-shell-consensus-disclosure">
            <summary><Award aria-hidden="true" />Best meeting times</summary>
            <div className="d-shell-disclosure-body">
              <ConsensusPanel poll={poll} onFinalizeSlot={canFinalize ? handleFinalizeSlot : undefined} />
            </div>
          </details>
        </div>
      ) : (
        <div role="tabpanel" id="tabpanel-answer" aria-labelledby="tab-answer-btn">
          <AvailabilityPainter
            key={painterKey}
            poll={poll}
            gridInterval={gridInterval}
            onSaveAvailability={handleSaveAvailability}
            onCancel={() => setActiveTab('overview')}
          />
        </div>
      )}

      <details className="d-shell-disclosure d-shell-management">
        <summary>Manage poll</summary>
        <div className="d-shell-disclosure-body">
          <div className="d-shell-management-head">
            <div>
              <h2>Participant responses</h2>
              <p>{poll.participants.length} {poll.participants.length === 1 ? 'person has' : 'people have'} responded.</p>
            </div>
            <button type="button" className="edu-btn-secondary" onClick={() => setActiveTab('answer')}>
              Add or update your times
            </button>
          </div>
          {poll.participants.length > 0 ? (
            <div className="d-shell-participants">
              {poll.participants.map((participant) => {
                const availableSlotsCount = Object.values(participant.availability).filter(
                  (status) => status === 'available' || status === 'preferred'
                ).length;
                return (
                  <div key={participant.id} className="d-shell-participant">
                    <div>
                      <strong>{participant.name}</strong>
                      <span>{availableSlotsCount} slots available</span>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${participant.name}'s response`}
                      onClick={() => setPendingDelete({ pollId: poll.id, id: participant.id, name: participant.name })}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="d-shell-muted">No responses yet. Share the poll to get started.</p>
          )}
          <div className="d-shell-management-actions">
            {!poll.finalizedSlot && (
              <button type="button" className="edu-btn-secondary" onClick={() => setIsExtendModalOpen(true)}>
                <CalendarPlus aria-hidden="true" /> Add dates
              </button>
            )}
            <button type="button" className="edu-btn-secondary d-shell-danger-action" onClick={handleDeleteCurrentPoll}>
              <Trash2 aria-hidden="true" /> Delete this poll
            </button>
          </div>
        </div>
      </details>
    </section>
  );

  return (
    <div
      className="d-shell-app min-h-screen bg-white text-stone-900 flex flex-col font-sans"
      data-screen={screen}
      data-step={screen === 'create' ? '1' : '0'}
      data-selection-state={screen === 'workspace' ? activeTab : 'none'}
      data-save-state={screen === 'workspace' ? 'saved' : screen === 'create' ? (isCreating ? 'creating' : 'idle') : 'idle'}
      data-active-poll-id={poll?.id ?? ''}
      data-loading={loading ? 'true' : 'false'}
    >
      <Header
        poll={screen === 'workspace' ? poll : null}
        screen={screen}
        onOpenShare={() => setIsShareModalOpen(true)}
        onGoHome={() => void goHome()}
        isBusy={isCreating}
      />

      <main className="d-shell-main flex-1 w-full">
        {loading ? (
          <div role="status" aria-labelledby="loading-caption" className="d-shell-loading">
            <div aria-hidden="true" />
            <p id="loading-caption">Loading meeting poll...</p>
          </div>
        ) : screen === 'home' ? (
          <HomePage
            polls={pollsList}
            listError={listError}
            onRetry={() => void fetchPollsList()}
            onCreatePoll={openCreatePoll}
            onOpenPoll={(id) => void fetchPoll(id)}
          />
        ) : screen === 'create' ? (
          <CreatePollPage
            onCancel={() => void goHome()}
            onCreatePoll={handleCreatePoll}
            defaultTimezone={BROWSER_TIMEZONE}
            onBusyChange={handleCreateBusyChange}
          />
        ) : screen === 'created' && createdPoll ? (
          <section className="d-shell-share-ready" data-share-ready="true" aria-labelledby="share-ready-title">
            <div className="d-shell-success-mark" aria-hidden="true">✓</div>
            <p className="d-shell-kicker">Poll created</p>
            <h1 id="share-ready-title">Your poll is ready to share.</h1>
            <p>Send the link to your group. The meeting is not booked until you choose a time.</p>
            <div className="d-shell-share-box">
              <label htmlFor="share-ready-link">Poll link</label>
              <div>
                <input id="share-ready-link" type="text" readOnly value={shareReadyUrl} />
                <button type="button" className="edu-btn-primary" onClick={() => void handleCopyShareReadyLink()}>
                  {shareReadyCopied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
            <div className="d-shell-share-actions">
              <button type="button" className="edu-btn-primary" onClick={openCreatedPoll}>Open poll</button>
              <button type="button" className="edu-btn-secondary" onClick={() => void goHome()}>Back to meetings</button>
            </div>
          </section>
        ) : error ? (
          <div role="alert" className="d-shell-error-state">
            <AlertCircle aria-hidden="true" />
            <h2>Poll error</h2>
            <p>{error}</p>
            <button
              type="button"
              className="edu-btn-secondary"
              onClick={() => {
                setError(null);
                const id = requestedPollIdRef.current ?? new URLSearchParams(window.location.search).get('poll');
                if (id) void fetchPoll(id, 'replace');
                else void goHome('replace');
              }}
            >
              Try again
            </button>
          </div>
        ) : workspace}
      </main>

      {screen === 'workspace' && poll && (
        <ExtendPollModal
          isOpen={isExtendModalOpen}
          onClose={() => setIsExtendModalOpen(false)}
          poll={poll}
          onAddDates={handleAddDates}
        />
      )}

      {screen === 'workspace' && poll && (
        <ShareModal
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          poll={poll}
        />
      )}

      <ConfirmDialog
        isOpen={pendingPollDelete !== null}
        title="Delete poll?"
        message={
          pendingPollDelete
            ? `"${pendingPollDelete.title}"${
                pendingPollDelete.participantsCount === 0
                  ? ''
                  : ` and its ${pendingPollDelete.participantsCount} ${pendingPollDelete.participantsCount === 1 ? 'response' : 'responses'}`
              } will be deleted for everyone. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete poll"
        danger
        onConfirm={() => void confirmDeletePoll()}
        onCancel={() => setPendingPollDelete(null)}
      />

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Remove response?"
        message={pendingDelete ? `${pendingDelete.name}'s availability will be deleted from this poll. This cannot be undone.` : ''}
        confirmLabel="Remove"
        danger
        onConfirm={() => void confirmDeleteParticipant()}
        onCancel={() => setPendingDelete(null)}
      />

      <Toast message={toast} />
    </div>
  );
}
