import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../../src/App';
import type { Poll } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

const poll: Poll = {
  id: 'switch', title: 'Grid switch', description: '', durationMinutes: 45, timezone: 'UTC',
  dates: ['2026-10-01'], startHour: 9, endHour: 11, slotInterval: 30,
  proposedSlots: { '2026-10-01': ['09:00', '09:30', '10:00', '10:30'] },
  creatorName: 'Test', createdAt: '', participants: [{
    id: 'participant', name: 'Participant', timezone: 'UTC', updatedAt: '',
    availability: {
      '2026-10-01T09:00': 'available',
      '2026-10-01T09:30': 'available',
      '2026-10-01T10:00': 'available',
      '2026-10-01T10:30': 'available',
    },
  }],
};

function mockApi() {
  localStorage.setItem('timesync_organizer_codes', JSON.stringify({ switch: 'code-switch' }));
  const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(
    new Response(JSON.stringify(String(url).startsWith('/api/polls?ids=') ? [{ ...poll, participantsCount: 0 }] : poll), {
      headers: { 'Content-Type': 'application/json' },
    })
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openPoll() {
  await screen.findByRole('heading', { name: 'Meetings' });
  fireEvent.click(screen.getByRole('button', { name: 'Grid switch' }));
  await screen.findByRole('heading', { name: 'Grid switch' });
}

function openCalendarSettings() {
  fireEvent.click(screen.getByText('Calendar settings'));
}

describe('grid view switch', () => {
  it('changes both grids without saving or discarding unsaved answers', async () => {
    const fetchMock = mockApi();
    render(h(App));
    await openPoll();
    openCalendarSettings();
    expect((screen.getByRole('radio', { name: '30 min' }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(4);
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: 'My answer' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: '30 min' }));
    fireEvent.keyDown(document.getElementById('paint-slot-2026-10-01T09:00')!, { key: 'Enter' });
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    expect(document.getElementById('paint-slot-2026-10-01T09:00')?.getAttribute('data-status')).toBe('mixed');
    fireEvent.click(screen.getByRole('radio', { name: '30 min' }));
    expect(document.getElementById('paint-slot-2026-10-01T09:00')?.getAttribute('data-status')).toBe('available');
    expect(document.getElementById('paint-slot-2026-10-01T09:30')?.getAttribute('data-status')).toBe('none');
    expect(screen.getByText('45 min')).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('remembers the view preference when the app reloads', async () => {
    mockApi();
    const first = render(h(App));
    await openPoll();
    openCalendarSettings();
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    first.unmount();
    render(h(App));
    await screen.findByRole('heading', { name: 'Grid switch' });
    openCalendarSettings();
    expect((screen.getByRole('radio', { name: '1 hour' }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('still switches views when browser storage is unavailable', async () => {
    mockApi();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    // Without storage the home page knows no polls, so open it by its link.
    window.history.replaceState({}, '', '/?poll=switch');
    render(h(App));
    await screen.findByRole('heading', { name: 'Grid switch' });
    openCalendarSettings();
    expect((screen.getByRole('radio', { name: '30 min' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});
