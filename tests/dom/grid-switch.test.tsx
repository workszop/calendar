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
  creatorName: 'Test', createdAt: '', participants: [],
};

function mockApi() {
  const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(
    new Response(JSON.stringify(String(url) === '/api/polls' ? [{ ...poll, participantsCount: 0 }] : poll), {
      headers: { 'Content-Type': 'application/json' },
    })
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('grid view switch', () => {
  it('changes both grids without saving or discarding unsaved answers', async () => {
    const fetchMock = mockApi();
    render(h(App));
    await screen.findByRole('heading', { name: 'Grid switch' });
    expect((screen.getByRole('radio', { name: '30 min' }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(4);
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Mark My Availability' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: '30 min' }));
    fireEvent.keyDown(document.getElementById('paint-slot-2026-10-01T09:00')!, { key: 'Enter' });
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    expect(document.getElementById('paint-slot-2026-10-01T09:00')?.getAttribute('data-status')).toBe('mixed');
    fireEvent.click(screen.getByRole('radio', { name: '30 min' }));
    expect(document.getElementById('paint-slot-2026-10-01T09:00')?.getAttribute('data-status')).toBe('available');
    expect(document.getElementById('paint-slot-2026-10-01T09:30')?.getAttribute('data-status')).toBe('none');
    expect(screen.getByText('45 Minutes Duration')).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('remembers the view preference when the app reloads', async () => {
    mockApi();
    const first = render(h(App));
    await screen.findByRole('heading', { name: 'Grid switch' });
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    first.unmount();
    render(h(App));
    await screen.findByRole('heading', { name: 'Grid switch' });
    expect((screen.getByRole('radio', { name: '1 hour' }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('still switches views when browser storage is unavailable', async () => {
    mockApi();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    render(h(App));
    await screen.findByRole('heading', { name: 'Grid switch' });
    expect((screen.getByRole('radio', { name: '30 min' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '1 hour' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});
