import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../src/App';
import type { Poll, PollSummary } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePoll(id: string, title: string): Poll {
  return {
    id,
    title,
    description: '',
    location: 'Online Meeting',
    durationMinutes: 30,
    timezone: 'UTC',
    dates: ['2026-10-01'],
    startHour: 9,
    endHour: 10,
    slotInterval: 30,
    creatorName: 'Ada',
    createdAt: '2026-09-01T00:00:00.000Z',
    finalizedSlot: null,
    participants: [],
  };
}

function summary(poll: Poll): PollSummary {
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    location: poll.location,
    durationMinutes: poll.durationMinutes,
    timezone: poll.timezone,
    dates: poll.dates,
    creatorName: poll.creatorName,
    createdAt: poll.createdAt,
    finalizedSlot: poll.finalizedSlot,
    participantsCount: poll.participants.length,
  };
}

describe('App navigation and home contract', () => {
  it('renders the real home at the root without opening an arbitrary poll', async () => {
    const poll1 = makePoll('p1', 'P1');
    const poll2 = makePoll('p2', 'P2');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll1), summary(poll2)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll1));
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });

    expect(screen.getByText('P1')).toBeTruthy();
    expect(screen.getByText('P2')).toBeTruthy();
    expect(fetchMock.mock.calls.map(([request]) => String(request))).toEqual(['/api/polls']);
    expect(document.querySelector('[data-screen="home"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'edulab, home' }).closest('header')?.getAttribute('data-header-density')).toBe('compact');
  });

  it('opens only the poll named by a shared query link', async () => {
    const poll1 = makePoll('p1', 'P1');
    const poll2 = makePoll('p2', 'P2');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll1), summary(poll2)]));
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/?poll=p2');

    render(h(App));
    await screen.findByRole('heading', { name: 'P2' });

    expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p2');
    expect(fetchMock.mock.calls.map(([request]) => String(request))).toEqual(['/api/polls', '/api/polls/p2']);
    expect(screen.queryByText('P1')).toBeNull();
    expect(screen.getByRole('tab', { name: 'My answer' }).getAttribute('aria-selected')).toBe('true');
  });

  it('returns home and removes the poll query', async () => {
    const poll = makePoll('p1', 'P1');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'P1' });
    fireEvent.click(screen.getByRole('button', { name: 'All meetings' }));
    await screen.findByRole('heading', { name: 'Meetings' });

    expect(window.location.search).toBe('');
    expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('');
  });

  it('follows Back and Forward between a poll and home', async () => {
    const poll = makePoll('p1', 'P1');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });
    fireEvent.click(screen.getByRole('button', { name: 'P1' }));
    await screen.findByRole('heading', { name: 'P1' });
    expect(window.location.search).toBe('?poll=p1');

    fireEvent.click(screen.getByRole('button', { name: 'All meetings' }));
    await screen.findByRole('heading', { name: 'Meetings' });
    expect(window.location.search).toBe('');

    window.history.pushState({}, '', '/?poll=p1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'P1' });
    expect(window.location.search).toBe('?poll=p1');
    // Back/Forward is not a freshly opened shared link: keep the overview tab.
    expect(screen.getByRole('tab', { name: 'Group overview' }).getAttribute('aria-selected')).toBe('true');

    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Meetings' });
    expect(window.location.search).toBe('');
  });

  it('makes a failed home list recoverable without opening a poll', async () => {
    const poll = makePoll('p1', 'Recoverable');
    let attempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== '/api/polls') throw new Error(`Unexpected ${String(input)}`);
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? jsonResponse({ error: 'List unavailable' }, 503) : jsonResponse([summary(poll)])
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });
    expect(screen.getByRole('alert').textContent).toContain('List unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Recoverable');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries the requested poll after a detail load failure from home', async () => {
    const poll = makePoll('p1', 'Retry detail');
    let detailAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll)]));
      if (url === '/api/polls/p1') {
        detailAttempts += 1;
        return Promise.resolve(
          detailAttempts === 1 ? jsonResponse({ error: 'Detail unavailable' }, 503) : jsonResponse(poll)
        );
      }
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry detail' }));
    await screen.findByRole('heading', { name: 'Poll error' });
    expect(window.location.search).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Retry detail' });
    expect(detailAttempts).toBe(2);
  });

  it('never lets a stale detail request resurrect an older poll', async () => {
    const oldPoll = makePoll('old', 'Old poll');
    const currentPoll = makePoll('current', 'Current poll');
    const oldDetail = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(oldPoll), summary(currentPoll)]));
      if (url === '/api/polls/old') return oldDetail.promise;
      if (url === '/api/polls/current') return Promise.resolve(jsonResponse(currentPoll));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });
    fireEvent.click(screen.getByRole('button', { name: 'Old poll' }));
    fireEvent.click(await screen.findByRole('button', { name: 'All meetings' }));
    await screen.findByRole('heading', { name: 'Meetings' });
    fireEvent.click(screen.getByRole('button', { name: 'Current poll' }));
    await screen.findByRole('heading', { name: 'Current poll' });

    oldDetail.resolve(jsonResponse(oldPoll));
    await waitFor(() => {
      expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('current');
    });
    expect(screen.getByRole('heading', { name: 'Current poll' })).toBeTruthy();
  });

  it('deletes an active poll only after confirmation and returns home', async () => {
    const poll = makePoll('p1', 'Delete me');
    let deleted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse(deleted ? [] : [summary(poll)]));
      if (url === '/api/polls/p1' && init?.method === 'DELETE') {
        deleted = true;
        return Promise.resolve(jsonResponse({ id: poll.id }));
      }
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll));
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Delete me' });
    fireEvent.click(screen.getByText('Manage poll'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this poll' }));
    expect(screen.getByRole('dialog', { name: 'Delete poll?' })).toBeTruthy();
    expect(deleted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete poll' }));
    await screen.findByRole('heading', { name: 'Meetings' });
    expect(deleted).toBe(true);
    expect(window.location.search).toBe('');
  });

  it('keeps a successful real create on a share-ready screen before opening it', async () => {
    const created = makePoll('created', 'Created meeting');
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls' && !init?.method) {
        listCalls += 1;
        return Promise.resolve(jsonResponse(listCalls === 1 ? [] : [summary(created)]));
      }
      if (url === '/api/polls' && init?.method === 'POST') return Promise.resolve(jsonResponse(created, 201));
      if (url === '/api/polls/created') return Promise.resolve(jsonResponse(created));
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'Meetings' });
    fireEvent.click(screen.getByRole('button', { name: 'Create a poll' }));
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Created meeting' } });
    expect(screen.queryByRole('button', { name: 'Dates & times' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next 3 Days' }));
    const slots = [...document.querySelectorAll<HTMLButtonElement>('[data-proposal-grid] [data-slot-key]')];
    for (const slot of slots) {
      if (slot.dataset.slotKey?.endsWith('T09:00') || slot.dataset.slotKey?.endsWith('T09:30')) {
        fireEvent.click(slot);
      }
    }
    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));

    await screen.findByRole('heading', { name: 'Your poll is ready to share.' });
    expect(document.querySelector('[data-share-ready="true"]')).toBeTruthy();
    expect(screen.getByDisplayValue(/\?poll=created/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open poll' }));
    await screen.findByRole('heading', { name: 'Created meeting' });
    expect(window.location.search).toBe('?poll=created');

    window.history.pushState({}, '', '/?created=created');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Your poll is ready to share.' });
  });

  it('keeps Add dates available in the real poll workspace', async () => {
    const poll = makePoll('p1', 'Extendable');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Extendable' });
    fireEvent.click(document.getElementById('add-dates-button')!);
    expect(screen.getByRole('dialog', { name: 'Add Dates' })).toBeTruthy();
  });
});
