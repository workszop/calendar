import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App async navigation contract', () => {
  it('keeps the latest selected poll when an older navigation resolves later', async () => {
    const poll1 = makePoll('p1', 'P1');
    const poll2 = makePoll('p2', 'P2');
    const olderNavigation = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll1), summary(poll2)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll1));
      if (url === '/api/polls/p2') return olderNavigation.promise;
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'P1' });

    fireEvent.click(screen.getByRole('button', { name: 'All Polls' }));
    fireEvent.click(await screen.findByRole('button', { name: /P2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'All Polls' }));
    fireEvent.click(await screen.findByRole('button', { name: /P1/ }));

    await waitFor(() => expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p1'));

    olderNavigation.resolve(jsonResponse(poll2));
    await settle();

    expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p1');
    expect(window.location.search).toBe('?poll=p1');
  });

  it('does not let a save response resurrect a poll after navigation', async () => {
    const poll1 = makePoll('p1', 'P1');
    const poll2 = makePoll('p2', 'P2');
    const saveResponse = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll1), summary(poll2)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll1));
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      if (url === '/api/polls/p1/respond' && init?.method === 'POST') return saveResponse.promise;
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'P1' });
    fireEvent.click(screen.getByRole('tab', { name: 'Mark My Availability' }));
    fireEvent.change(await screen.findByLabelText(/Your Name/), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));

    fireEvent.click(screen.getByRole('button', { name: 'All Polls' }));
    fireEvent.click(await screen.findByRole('button', { name: /P2/ }));
    await waitFor(() => expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p2'));

    saveResponse.resolve(jsonResponse({ poll: { ...poll1, participants: [] } }));
    await settle();

    expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p2');
  });

  it('does not install a newly created draft poll after navigation during draft save', async () => {
    const poll2 = makePoll('p2', 'P2');
    const created = makePoll('created', 'Created draft');
    const createResponse = deferred<Response>();
    const respondResponse = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls' && !init?.method) return Promise.resolve(jsonResponse([]));
      if (url === '/api/polls' && init?.method === 'POST') return createResponse.promise;
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      if (url === '/api/polls/created/respond') return respondResponse.promise;
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await waitFor(() => expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('draft'));
    fireEvent.click(screen.getByRole('tab', { name: 'Mark My Availability' }));
    fireEvent.change(await screen.findByLabelText(/Your Name/), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));

    window.history.pushState({}, '', '/?poll=p2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p2'));

    createResponse.resolve(jsonResponse(created, 201));
    await settle();

    expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p2');
    respondResponse.resolve(jsonResponse({ poll: { ...created, participants: [] } }));
    await settle();
  });

  it('refreshes the poll list when a create finishes after navigation', async () => {
    const poll2 = makePoll('p2', 'P2');
    const created = makePoll('created', 'Created draft');
    const createResponse = deferred<Response>();
    const respondResponse = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls' && !init?.method) {
        return fetchMock.mock.calls.filter(([request]) => String(request) === '/api/polls').length === 1
          ? Promise.resolve(jsonResponse([]))
          : Promise.resolve(jsonResponse([summary(created)]));
      }
      if (url === '/api/polls' && init?.method === 'POST') return createResponse.promise;
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      if (url === '/api/polls/created/respond') return respondResponse.promise;
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await waitFor(() =>
      expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('draft')
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Mark My Availability' }));
    fireEvent.change(await screen.findByLabelText(/Your Name/), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));

    window.history.pushState({}, '', '/?poll=p2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'P2' });

    createResponse.resolve(jsonResponse(created, 201));
    await settle();
    respondResponse.resolve(jsonResponse({ poll: { ...created, participants: [] } }));

    fireEvent.click(screen.getByRole('button', { name: 'All Polls' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Created draft/ })).toBeTruthy());
  });

  it('clears a pending participant confirmation when navigation changes polls', async () => {
    const poll1 = makePoll('p1', 'P1');
    poll1.participants = [
      {
        id: 'participant-1',
        name: 'Bob',
        timezone: 'UTC',
        updatedAt: '',
        availability: {},
      },
    ];
    const poll2 = makePoll('p2', 'P2');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(poll1), summary(poll2)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll1));
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'P1' });
    fireEvent.click(screen.getByRole('button', { name: "Remove Bob's response" }));
    expect(screen.getByRole('dialog', { name: 'Remove response?' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'All Polls' }));
    fireEvent.click(await screen.findByRole('button', { name: /P2/ }));
    await screen.findByRole('heading', { name: 'P2' });

    expect(screen.queryByRole('dialog', { name: 'Remove response?' })).toBeNull();
    expect(fetchMock.mock.calls.some(([request]) => String(request).includes('/respond/'))).toBe(false);
  });
  it('deletes the poll on screen after confirmation and moves to the next poll', async () => {
    const poll1 = makePoll('p1', 'P1');
    const poll2 = makePoll('p2', 'P2');
    let deleted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/polls') {
        return Promise.resolve(jsonResponse(deleted ? [summary(poll2)] : [summary(poll1), summary(poll2)]));
      }
      if (url === '/api/polls/p1' && init?.method === 'DELETE') {
        deleted = true;
        return Promise.resolve(jsonResponse({ id: 'p1' }));
      }
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(poll1));
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(poll2));
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(App));
    await screen.findByRole('heading', { name: 'P1' });
    fireEvent.click(screen.getByRole('button', { name: 'All Polls' }));
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-poll-id="p1"]');
      if (!found) throw new Error('row missing');
      return found;
    });
    fireEvent.click(row.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!);

    // Nothing is removed until the dialog is confirmed.
    expect(screen.getByRole('dialog', { name: 'Delete poll?' })).toBeTruthy();
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete poll' }));

    await screen.findByRole('heading', { name: 'P2' });
    expect(deleted).toBe(true);
    expect(window.location.search).toBe('?poll=p2');
  });
  it('Home and the logo return to the main page: the newest poll on the heatmap', async () => {
    const newest = makePoll('p1', 'Newest');
    const older = makePoll('p2', 'Older');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/polls') return Promise.resolve(jsonResponse([summary(newest), summary(older)]));
      if (url === '/api/polls/p1') return Promise.resolve(jsonResponse(newest));
      if (url === '/api/polls/p2') return Promise.resolve(jsonResponse(older));
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/?poll=p2');

    render(h(App));
    await screen.findByRole('heading', { name: 'Older' });
    // Arrived by link, so the painter is open.
    expect(screen.getByRole('tab', { name: 'Mark My Availability' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    await screen.findByRole('heading', { name: 'Newest' });
    expect(window.location.search).toBe('?poll=p1');
    expect(screen.getByRole('tab', { name: 'Group Heatmap' }).getAttribute('aria-selected')).toBe('true');

    const historyLength = window.history.length;
    fireEvent.click(screen.getByRole('link', { name: /edulab/ }));
    await settle();
    expect(window.history.length).toBe(historyLength);
    expect(document.querySelector('[data-active-poll-id]')?.getAttribute('data-active-poll-id')).toBe('p1');
  });
});
