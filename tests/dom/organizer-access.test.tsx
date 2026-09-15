import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { apiRetry } from '../../src/App';
import type { Poll, PollSummary } from '../../src/types';

beforeEach(() => {
  apiRetry.baseDelayMs = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 'p1',
    title: 'Guarded',
    description: '',
    location: 'Online Meeting',
    durationMinutes: 30,
    timezone: 'UTC',
    dates: ['2026-10-01'],
    startHour: 9,
    endHour: 10,
    slotInterval: 30,
    creatorName: 'Ada',
    createdAt: '',
    finalizedSlot: null,
    participants: [
      { id: 'part_bob', name: 'Bob', timezone: 'UTC', updatedAt: '', availability: { '2026-10-01T09:00': 'available' } },
    ],
    ...overrides,
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** Records every request with its headers; `handler` answers by method and path. */
function mockFetch(handler: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const response = handler(call);
    if (!response) throw new Error(`Unexpected ${call.method} ${call.url}`);
    return Promise.resolve(response);
  }));
  return calls;
}

/** Home list answer naming every requested id, so none is forgotten as deleted. */
function listFor(url: string, poll: Poll): Response {
  const ids = decodeURIComponent(url.split('?ids=')[1] ?? '').split(',');
  const summary: PollSummary = {
    id: poll.id, title: poll.title, description: poll.description, location: poll.location,
    durationMinutes: poll.durationMinutes, timezone: poll.timezone, dates: poll.dates,
    creatorName: poll.creatorName, createdAt: poll.createdAt, finalizedSlot: poll.finalizedSlot,
    participantsCount: poll.participants.length,
  };
  return jsonResponse(ids.includes(poll.id) ? [summary] : []);
}

function storedResponses(): Record<string, { participantId: string; editCode: string }> {
  return JSON.parse(localStorage.getItem('timesync_responses') ?? '{}');
}

function storedCodes(): Record<string, string> {
  return JSON.parse(localStorage.getItem('timesync_organizer_codes') ?? '{}');
}

describe('organizer access', () => {
  it('hides organizer tools from visitors and unlocks them only with a matching code', async () => {
    const poll = makePoll();
    const calls = mockFetch(({ url, headers }) => {
      if (url === '/api/polls/p1') return jsonResponse(poll);
      if (url === '/api/polls/p1/access') return jsonResponse({ organizer: headers['x-organizer-code'] === 'right-code' });
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    fireEvent.click(screen.getByRole('tab', { name: 'Group overview' }));
    fireEvent.click(screen.getByText('Manage poll'));

    expect(document.getElementById('add-dates-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete this poll' })).toBeNull();
    expect(screen.queryByRole('button', { name: "Remove Bob's response" })).toBeNull();
    expect(document.querySelector('[data-organizer-unlock]')).toBeTruthy();

    const input = screen.getByLabelText(/Are you the organizer/);
    fireEvent.change(input, { target: { value: 'wrong-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not match/);
    expect(storedCodes()).toEqual({});

    fireEvent.change(input, { target: { value: 'right-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('button', { name: 'Delete this poll' });
    expect(storedCodes()).toEqual({ p1: 'right-code' });
    expect(document.getElementById('add-dates-button')).toBeTruthy();
    expect(screen.getByRole('button', { name: "Remove Bob's response" })).toBeTruthy();
    expect(document.querySelector('[data-organizer-code-panel]')).toBeTruthy();
    expect(calls.filter((call) => call.url === '/api/polls/p1').at(-1)?.headers['x-organizer-code']).toBe('right-code');
  });

  it('keeps the code from an organizer link, removes it from the URL and sends it with requests', async () => {
    const poll = makePoll();
    const calls = mockFetch(({ url, method, headers }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url === '/api/polls/p1/access') return jsonResponse({ organizer: headers['x-organizer-code'] === 'link-code' });
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1#organizer=link-code');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });

    expect(storedCodes()).toEqual({ p1: 'link-code' });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?poll=p1');
    expect(calls.find((call) => call.url === '/api/polls/p1')?.headers['x-organizer-code']).toBe('link-code');
    // The link code was checked once before it was kept, and not re-checked.
    expect(calls.filter((call) => call.url === '/api/polls/p1/access')).toHaveLength(1);
    expect(document.querySelector('[data-organizer-state]')?.getAttribute('data-organizer-state')).toBe('organizer');
  });

  it('hides Re-open voting from visitors of a locked poll', async () => {
    const poll = makePoll({
      finalizedSlot: { date: '2026-10-01', startTime: '09:00', endTime: '09:30', confirmedBy: 'Ada', confirmedAt: '' },
    });
    mockFetch(({ url }) => (url === '/api/polls/p1' ? jsonResponse(poll) : url.startsWith('/api/polls?ids=') ? jsonResponse([]) : undefined));
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    expect(document.getElementById('finalized-meeting-banner')).toBeTruthy();
    expect(document.getElementById('reopen-poll-button')).toBeNull();
  });

  it('shows the new organizer code after creating a poll and lets the organizer save it as a file', async () => {
    const created = makePoll({ id: 'created', title: 'Fresh poll', participants: [] });
    mockFetch(({ url, method }) => {
      if (url === '/api/polls' && method === 'POST') return jsonResponse({ ...created, organizerCode: 'fresh-code' }, 201);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, created);
      return undefined;
    });
    const createObjectURL = vi.fn(() => 'blob:code');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });
    fireEvent.click(screen.getByRole('button', { name: 'Create a poll' }));
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Fresh poll' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next 3 Days' }));
    for (const slot of document.querySelectorAll<HTMLButtonElement>('[data-proposal-grid] [data-slot-key]')) {
      if (slot.dataset.slotKey?.endsWith('T09:00')) fireEvent.click(slot);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));

    await screen.findByRole('heading', { name: 'Your poll is ready to share.' });
    expect(storedCodes()).toEqual({ created: 'fresh-code' });
    expect(document.querySelector('[data-organizer-code-panel="prompt"]')).toBeTruthy();
    expect(screen.getByDisplayValue('fresh-code')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save as file' }));
    expect(click).toHaveBeenCalledOnce();
    const [blob] = createObjectURL.mock.calls[0] as unknown as [Blob];
    const text = await blob.text();
    expect(text).toContain('Code: fresh-code');
    expect(text).toMatch(/\?poll=created#organizer=fresh-code/);
  });

  it("stores a participant's edit code and sends it when they update their answer", async () => {
    let poll = makePoll({ participants: [] });
    const calls = mockFetch(({ url, method, body, headers }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') {
        const { name, availability } = body as { name: string; availability: Record<string, 'available'> };
        poll = { ...poll, participants: [{ id: 'part_me', name, timezone: 'UTC', updatedAt: '', availability }] };
        const first = !(body as { participantId?: string }).participantId;
        return jsonResponse({ poll, participant: poll.participants[0], ...(first ? { editCode: headers['x-edit-code'] } : {}) });
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(storedResponses().p1?.participantId).toBe('part_me'));
    const editCode = storedResponses().p1.editCode;
    expect(editCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(localStorage.getItem('timesync_pending_edit_codes')).toBe('{}');

    fireEvent.click(screen.getByRole('tab', { name: 'My answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/polls/p1/respond')).toHaveLength(2));
    const [first, second] = calls.filter((call) => call.url === '/api/polls/p1/respond');
    // The first save carries the browser-made code; the update proves itself with it.
    expect(first.headers['x-edit-code']).toBe(editCode);
    expect((first.body as { participantId?: string }).participantId).toBeUndefined();
    expect(second.headers['x-edit-code']).toBe(editCode);
    expect((second.body as { participantId?: string }).participantId).toBe('part_me');
  });

  // ─── Verified organizer status (B2, B4) ───

  it('never lets a crafted organizer link replace a stored code that still works', async () => {
    localStorage.setItem('timesync_organizer_codes', JSON.stringify({ p1: 'good-code' }));
    const poll = makePoll();
    const calls = mockFetch(({ url, headers }) => {
      if (url === '/api/polls/p1') return jsonResponse(poll);
      if (url === '/api/polls/p1/access') return jsonResponse({ organizer: headers['x-organizer-code'] === 'good-code' });
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1#organizer=evil-code');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    await waitFor(() =>
      expect(document.querySelector('[data-organizer-state]')?.getAttribute('data-organizer-state')).toBe('organizer')
    );
    expect(storedCodes()).toEqual({ p1: 'good-code' });
    expect(window.location.hash).toBe('');
    expect(screen.getByText('That organizer link does not match this poll.')).toBeTruthy();
    expect(calls.filter((call) => call.url === '/api/polls/p1/access').map((call) => call.headers['x-organizer-code']))
      .toEqual(['evil-code', 'good-code']);
  });

  it('does not show organizer tools while a stored code is being verified', async () => {
    localStorage.setItem('timesync_organizer_codes', JSON.stringify({ p1: 'stored-code' }));
    const poll = makePoll();
    let answerAccess: ((response: Response) => void) | undefined;
    mockFetch(({ url }) => {
      if (url === '/api/polls/p1') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      return undefined;
    });
    const plainFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      return String(input) === '/api/polls/p1/access'
        ? new Promise<Response>((resolve) => { answerAccess = resolve; })
        : plainFetch(input, init);
    }));
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    fireEvent.click(screen.getByText('Manage poll'));
    const workspace = document.querySelector('[data-organizer-state]');
    expect(workspace?.getAttribute('data-organizer-state')).toBe('unknown');
    expect(document.getElementById('add-dates-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete this poll' })).toBeNull();
    expect(document.querySelector('[data-organizer-unlock]')).toBeNull();
    expect(document.querySelector('[data-organizer-checking]')).toBeTruthy();

    answerAccess?.(jsonResponse({ organizer: true }));
    await screen.findByRole('button', { name: 'Delete this poll' });
    expect(workspace?.getAttribute('data-organizer-state')).toBe('organizer');
  });

  it('drops a stored code the server no longer accepts and offers the unlock form', async () => {
    localStorage.setItem('timesync_organizer_codes', JSON.stringify({ p1: 'stale-code' }));
    const poll = makePoll();
    mockFetch(({ url }) => {
      if (url === '/api/polls/p1') return jsonResponse(poll);
      if (url === '/api/polls/p1/access') return jsonResponse({ organizer: false });
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    await waitFor(() => expect(document.querySelector('[data-organizer-unlock]')).toBeTruthy());
    expect(storedCodes()).toEqual({});
    expect(document.querySelector('[data-organizer-state]')?.getAttribute('data-organizer-state')).toBe('visitor');
  });

  it('clears the organizer code on a 403 from an organizer action and shows the unlock form again', async () => {
    localStorage.setItem('timesync_organizer_codes', JSON.stringify({ p1: 'revoked-code' }));
    const poll = makePoll();
    const message = 'Only the organizer can do this. Enter the organizer code to unlock it.';
    mockFetch(({ url, method }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url === '/api/polls/p1/access') return jsonResponse({ organizer: true });
      if (url === '/api/polls/p1/respond/part_bob' && method === 'DELETE') return jsonResponse({ error: message }, 403);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    fireEvent.click(screen.getByRole('tab', { name: 'Group overview' }));
    fireEvent.click(await screen.findByRole('button', { name: "Remove Bob's response" }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(document.querySelector('[data-organizer-unlock]')).toBeTruthy());
    expect(storedCodes()).toEqual({});
    expect(document.querySelector('[data-organizer-notice]')?.textContent).toBe(message);
    expect(document.querySelector<HTMLDetailsElement>('.d-shell-management')?.open).toBe(true);
    expect(screen.queryByRole('button', { name: "Remove Bob's response" })).toBeNull();
    expect(document.querySelector('[data-organizer-state]')?.getAttribute('data-organizer-state')).toBe('visitor');
  });

  // ─── Saving answers (B10, contracts 1, 3, 4, 5) ───

  function ownPoll(): Poll {
    return makePoll({
      participants: [
        { id: 'part_me', name: 'Me', timezone: 'UTC', updatedAt: '', availability: { '2026-10-01T09:00': 'available' } },
      ],
    });
  }

  function respondCalls(calls: Call[]) {
    return calls.filter((call) => call.url === '/api/polls/p1/respond');
  }

  async function openAnswerTab() {
    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    return screen.findByRole('button', { name: 'Save My Availability' });
  }

  it('offers "Save as a new response" after a 403 on an update, keeping the painted grid', async () => {
    localStorage.setItem('timesync_responses', JSON.stringify({ p1: { participantId: 'part_me', editCode: 'old-code' } }));
    let poll = ownPoll();
    const message = 'This response can only be changed from the browser that saved it.';
    const calls = mockFetch(({ url, method, body, headers }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') {
        const payload = body as { participantId?: string; availability: Record<string, 'available'> };
        if (payload.participantId) return jsonResponse({ error: message }, 403);
        const participant = { id: 'part_new', name: 'Me', timezone: 'UTC', updatedAt: '', availability: payload.availability };
        poll = { ...poll, participants: [...poll.participants, participant] };
        return jsonResponse({ poll, participant, editCode: headers['x-edit-code'] });
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    const save = await openAnswerTab();
    fireEvent.keyDown(document.getElementById('paint-slot-2026-10-01T09:30')!, { key: 'Enter' });
    fireEvent.click(save);

    const saveAsNew = await screen.findByRole('button', { name: 'Save as a new response' });
    expect(document.querySelector('[data-save-status]')?.textContent).toBe(message);
    expect(storedResponses()).toEqual({});
    expect(document.getElementById('paint-slot-2026-10-01T09:00')?.getAttribute('data-status')).toBe('available');
    expect(document.getElementById('paint-slot-2026-10-01T09:30')?.getAttribute('data-status')).toBe('available');

    fireEvent.click(saveAsNew);
    await waitFor(() => expect(storedResponses().p1?.participantId).toBe('part_new'));
    const [, retry] = respondCalls(calls);
    expect((retry.body as { participantId?: string }).participantId).toBeUndefined();
    expect(retry.headers['x-edit-code']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((retry.body as { availability: Record<string, string> }).availability).toEqual({
      '2026-10-01T09:00': 'available',
      '2026-10-01T09:30': 'available',
    });
  });

  it('clears the stored response when the server no longer knows the participant', async () => {
    localStorage.setItem('timesync_responses', JSON.stringify({ p1: { participantId: 'part_me', editCode: 'code' } }));
    const poll = ownPoll();
    mockFetch(({ url, method }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') return jsonResponse({ error: 'Participant not found' }, 404);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    fireEvent.click(await openAnswerTab());
    await waitFor(() => expect(document.querySelector('[data-save-status]')?.textContent).toMatch(/was removed/));
    expect(storedResponses()).toEqual({});
  });

  it('reuses the pending edit code when a first save is retried after a network failure', async () => {
    let poll = makePoll({ participants: [] });
    let attempts = 0;
    const calls = mockFetch(({ url, method, headers }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        const participant = { id: 'part_me', name: 'Me', timezone: 'UTC', updatedAt: '', availability: {} };
        poll = { ...poll, participants: [participant] };
        return jsonResponse({ poll, participant, editCode: headers['x-edit-code'] });
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    const save = await openAnswerTab();
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Me' } });
    fireEvent.click(save);
    await waitFor(() => expect(document.querySelector('[data-answer-footer]')?.getAttribute('data-save-state')).toBe('error'));
    const pending = JSON.parse(localStorage.getItem('timesync_pending_edit_codes') ?? '{}').p1;
    expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/);

    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(storedResponses().p1).toEqual({ participantId: 'part_me', editCode: pending }));
    expect(respondCalls(calls).map((call) => call.headers['x-edit-code'])).toEqual([pending, pending]);
    expect(JSON.parse(localStorage.getItem('timesync_pending_edit_codes') ?? '{}')).toEqual({});
  });

  it('retries a retryable storage conflict up to three attempts', async () => {
    let poll = makePoll({ participants: [] });
    let attempts = 0;
    const calls = mockFetch(({ url, method, headers }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') {
        attempts += 1;
        if (attempts < 3) return jsonResponse({ error: 'Busy, try again', retryable: true }, 409);
        const participant = { id: 'part_me', name: 'Me', timezone: 'UTC', updatedAt: '', availability: {} };
        poll = { ...poll, participants: [participant] };
        return jsonResponse({ poll, participant, editCode: headers['x-edit-code'] });
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    const save = await openAnswerTab();
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Me' } });
    fireEvent.click(save);
    await waitFor(() => expect(storedResponses().p1?.participantId).toBe('part_me'));
    const sent = respondCalls(calls);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((call) => call.headers['x-edit-code'])).size).toBe(1);
  });

  it('gives up after three retryable conflicts and never retries other 409s', async () => {
    const poll = makePoll({ participants: [] });
    let closed = false;
    const calls = mockFetch(({ url, method }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') {
        return closed
          ? jsonResponse({ error: 'Voting is closed. The organizer must re-open voting before answers can change.' }, 409)
          : jsonResponse({ error: 'Busy, try again', retryable: true }, 409);
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    const save = await openAnswerTab();
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Me' } });
    fireEvent.click(save);
    await waitFor(() => expect(document.querySelector('[data-answer-footer]')?.getAttribute('data-save-state')).toBe('error'));
    expect(respondCalls(calls)).toHaveLength(3);

    closed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() =>
      expect(document.querySelector('[data-save-status]')?.textContent).toBe(
        'Voting is closed. The organizer must re-open voting before answers can change.'
      )
    );
    expect(respondCalls(calls)).toHaveLength(4);
  });

  it('shows the server message in a toast on 429', async () => {
    const poll = makePoll({ participants: [] });
    const message = 'Too many changes. Try again in a minute.';
    mockFetch(({ url, method }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') return new Response(JSON.stringify({ error: message }), { status: 429, headers: { 'Retry-After': '30' } });
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    const save = await openAnswerTab();
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Me' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThanOrEqual(2));
    expect(document.querySelector('[aria-live="polite"].fixed')?.textContent).toBe(message);
  });

  it('omits an empty email when updating its own response and sends a typed one', async () => {
    localStorage.setItem('timesync_responses', JSON.stringify({ p1: { participantId: 'part_me', editCode: 'code' } }));
    let poll = ownPoll();
    const calls = mockFetch(({ url, method }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return listFor(url, poll);
      if (url === '/api/polls/p1/respond') {
        poll = { ...poll };
        return jsonResponse({ poll, participant: poll.participants[0] });
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    fireEvent.click(await openAnswerTab());
    await waitFor(() => expect(respondCalls(calls)).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: 'My answer' }));
    fireEvent.change(await screen.findByLabelText(/Your Email/), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(respondCalls(calls)).toHaveLength(2));

    const [emptyUpdate, typedUpdate] = respondCalls(calls);
    expect(emptyUpdate.body).not.toHaveProperty('email');
    expect((emptyUpdate.body as { participantId?: string }).participantId).toBe('part_me');
    expect(typedUpdate.body).toMatchObject({ email: 'me@example.com', participantId: 'part_me' });
  });
});
