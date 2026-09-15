import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../src/App';
import type { Poll } from '../../src/types';

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

function storedCodes(): Record<string, string> {
  return JSON.parse(localStorage.getItem('timesync_organizer_codes') ?? '{}');
}

describe('organizer access', () => {
  it('hides organizer tools from visitors and unlocks them only with a matching code', async () => {
    const poll = makePoll();
    const calls = mockFetch(({ url, headers }) => {
      if (url === '/api/polls/p1') return jsonResponse(poll);
      if (url === '/api/polls/p1/access') return jsonResponse({ organizer: headers['x-organizer-code'] === 'right-code' });
      if (url.startsWith('/api/polls?ids=')) return jsonResponse([]);
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
    const calls = mockFetch(({ url, method }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url === '/api/polls/p1/reset') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return jsonResponse([]);
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1#organizer=link-code');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });

    expect(storedCodes()).toEqual({ p1: 'link-code' });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?poll=p1');
    expect(calls.find((call) => call.url === '/api/polls/p1')?.headers['x-organizer-code']).toBe('link-code');
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
      if (url.startsWith('/api/polls?ids=')) return jsonResponse([]);
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
      // Two back-to-back half-hours hold the default 60-minute meeting.
      if (/T09:(00|30)$/.test(slot.dataset.slotKey ?? '')) fireEvent.click(slot);
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
    const calls = mockFetch(({ url, method, body }) => {
      if (url === '/api/polls/p1' && method === 'GET') return jsonResponse(poll);
      if (url.startsWith('/api/polls?ids=')) return jsonResponse([]);
      if (url === '/api/polls/p1/respond') {
        const { name, availability } = body as { name: string; availability: Record<string, 'available'> };
        poll = { ...poll, participants: [{ id: 'part_me', name, timezone: 'UTC', updatedAt: '', availability }] };
        const first = !(body as { participantId?: string }).participantId;
        return jsonResponse({ poll, participant: poll.participants[0], ...(first ? { editCode: 'edit-me' } : {}) });
      }
      return undefined;
    });
    window.history.replaceState({}, '', '/?poll=p1');

    render(h(App));
    await screen.findByRole('heading', { name: 'Guarded' });
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('timesync_responses') ?? '{}')).toEqual({
      p1: { participantId: 'part_me', editCode: 'edit-me' },
    }));

    fireEvent.click(screen.getByRole('tab', { name: 'My answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/polls/p1/respond')).toHaveLength(2));
    const [first, second] = calls.filter((call) => call.url === '/api/polls/p1/respond');
    expect(first.headers['x-edit-code']).toBeUndefined();
    expect((first.body as { participantId?: string }).participantId).toBeUndefined();
    expect(second.headers['x-edit-code']).toBe('edit-me');
    expect((second.body as { participantId?: string }).participantId).toBe('part_me');
  });
});
