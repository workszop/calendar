import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HomePage } from '../../src/components/HomePage';
import type { PollSummary } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeSummary(id: string, title: string, finalizedSlot: PollSummary['finalizedSlot'] = null): PollSummary {
  return {
    id,
    title,
    description: '',
    location: 'Online Meeting',
    durationMinutes: 30,
    timezone: 'UTC',
    dates: ['2026-10-01'],
    creatorName: 'Ada',
    createdAt: '2026-09-01T00:00:00.000Z',
    finalizedSlot,
    participantsCount: 2,
  };
}

describe('HomePage', () => {
  it('opens meeting creation from the large plus on the empty home screen', () => {
    const onCreatePoll = vi.fn();
    render(h(HomePage, { polls: [], onOpenPoll: vi.fn(), onCreatePoll }));
    const plus = screen.getByRole('button', { name: 'Create a meeting' });
    expect(plus.getAttribute('type')).toBe('button');
    expect(plus.classList.contains('d-home-empty-symbol')).toBe(true);
    fireEvent.click(plus);
    expect(onCreatePoll).toHaveBeenCalledOnce();
  });

  it('keeps a single create action in the viewport dock for long lists and empty home', () => {
    const result = render(h(HomePage, { polls: Array.from({ length: 30 }, (_, i) => makeSummary(String(i), `Meeting ${i}`)), onOpenPoll: vi.fn(), onCreatePoll: vi.fn() }));
    expect(screen.getByRole('button', { name: 'Create a poll' }).closest('[data-action-dock]')).not.toBeNull();
    result.rerender(h(HomePage, { polls: [], onOpenPoll: vi.fn(), onCreatePoll: vi.fn() }));
    expect(screen.getAllByRole('button', { name: 'Create a poll' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create a poll' }).closest('[data-action-dock]')).not.toBeNull();
  });
  it('shows open meetings first without claiming readiness from a summary', () => {
    const onOpenPoll = vi.fn();
    render(
      h(HomePage, {
        polls: [
          makeSummary('open', 'Open workshop'),
          makeSummary('agreed', 'Agreed retro', {
            date: '2026-10-01',
            startTime: '09:00',
            endTime: '09:30',
            confirmedBy: 'Ada',
            confirmedAt: '2026-09-01T00:00:00.000Z',
          }),
        ],
        onOpenPoll,
        onCreatePoll: vi.fn(),
      })
    );

    expect(screen.getByRole('heading', { name: 'Meetings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Open workshop')).toBeTruthy();
    expect(screen.queryByText('Ready to choose')).toBeNull();
    expect(screen.queryByText('Voting is open. Review responses as they arrive.')).toBeTruthy();
    expect(screen.queryByText('Agreed retro')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Agreed retro')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Agreed retro' }));
    expect(onOpenPoll).toHaveBeenCalledWith('agreed');
  });

  it('filters by search and offers a real empty state with one create action', () => {
    const onCreatePoll = vi.fn();
    render(
      h(HomePage, {
        polls: [makeSummary('p1', 'Planning')],
        onOpenPoll: vi.fn(),
        onCreatePoll,
      })
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a meeting' }), {
      target: { value: 'missing' },
    });
    expect(screen.getByRole('heading', { name: 'No matching meetings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear search and show all' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and show all' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a meeting' }), {
      target: { value: 'missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and show all' }));
    expect(screen.getByText('Planning')).toBeTruthy();

    cleanup();
    render(h(HomePage, { polls: [], onOpenPoll: vi.fn(), onCreatePoll }));
    expect(screen.getByRole('heading', { name: 'Your first meeting starts here.' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Create a poll/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create a poll' }));
    expect(onCreatePoll).toHaveBeenCalledTimes(1);
  });

  it('reports a recoverable list error', () => {
    const onRetry = vi.fn();
    render(
      h(HomePage, {
        polls: [],
        listError: 'Could not load meetings.',
        onOpenPoll: vi.fn(),
        onCreatePoll: vi.fn(),
        onRetry,
      })
    );

    expect(screen.getByRole('alert').textContent).toContain('Could not load meetings.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not present a failed list as a true empty workspace', () => {
    render(
      h(HomePage, {
        polls: [],
        listError: 'Could not load meetings.',
        onOpenPoll: vi.fn(),
        onCreatePoll: vi.fn(),
        onRetry: vi.fn(),
      })
    );

    expect(screen.queryByRole('heading', { name: 'Your first meeting starts here.' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Meetings are unavailable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps a semantic, locale-safe date tile', () => {
    render(
      h(HomePage, {
        polls: [makeSummary('locale', 'Locale check')],
        onOpenPoll: vi.fn(),
        onCreatePoll: vi.fn(),
      })
    );

    const tile = document.querySelector('[data-date="2026-10-01"]');
    expect(tile).toBeTruthy();
    expect(tile?.getAttribute('aria-hidden')).toBeNull();
    expect(tile?.querySelector('strong')?.textContent).toBe('1');
    expect(tile?.querySelector('.sr-only')?.textContent).toContain('2026');
  });
});
