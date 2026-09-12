import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Poll } from '../../src/types';
import { HeatmapGrid } from '../../src/components/HeatmapGrid';

afterEach(cleanup);

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 'poll_heatmap',
    title: 'Heatmap',
    description: '',
    durationMinutes: 60,
    timezone: 'UTC',
    dates: ['2026-10-01'],
    startHour: 9,
    endHour: 10,
    slotInterval: 30,
    creatorName: 'Ada',
    createdAt: '',
    finalizedSlot: null,
    participants: [
      {
        id: 'a',
        name: 'Ann',
        timezone: 'UTC',
        updatedAt: '',
        availability: {
          '2026-10-01T09:00': 'available',
          '2026-10-01T09:30': 'available',
        },
      },
    ],
    ...overrides,
  };
}

describe('HeatmapGrid finalization control', () => {
  it('counts attendance over the full hour rather than only its first half', () => {
    const poll = makePoll();
    poll.participants[0].availability['2026-10-01T09:30'] = 'unavailable';
    render(h(HeatmapGrid, {
      poll, gridInterval: 60, activeParticipantFilter: null, onSelectParticipantFilter: () => {},
    }));
    expect(document.querySelectorAll('tbody button')).toHaveLength(1);
    expect(document.getElementById('slot-2026-10-01-09:00')?.getAttribute('aria-label')).toContain('0 of 1 available');
  });

  it('shows a filtered participant as Mixed if their half-hour answers differ', () => {
    const poll = makePoll();
    poll.participants[0].availability['2026-10-01T09:30'] = 'preferred';
    render(h(HeatmapGrid, {
      poll, gridInterval: 60, activeParticipantFilter: 'a', onSelectParticipantFilter: () => {},
    }));
    expect(document.getElementById('slot-2026-10-01-09:00')?.textContent).toContain('Mixed');
  });

  it('keeps an agreed half-hour visible when viewing whole hours', () => {
    render(h(HeatmapGrid, {
      poll: makePoll({ finalizedSlot: { date: '2026-10-01', startTime: '09:30', endTime: '10:00', confirmedBy: 'Test', confirmedAt: '' } }),
      gridInterval: 60, activeParticipantFilter: null, onSelectParticipantFilter: () => {},
    }));
    expect(document.getElementById('slot-2026-10-01-09:00')?.textContent).toContain('Confirmed');
  });

  it('hides the quick lock when the selected start cannot fit the full duration', () => {
    const onFinalizeSlot = vi.fn();
    render(
      h(HeatmapGrid, {
        poll: makePoll(),
        onFinalizeSlot,
        activeParticipantFilter: null,
        onSelectParticipantFilter: () => {},
      })
    );

    fireEvent.click(document.getElementById('slot-2026-10-01-09:30') as HTMLElement);

    expect(screen.queryByRole('button', { name: 'Agree on this timing' })).toBeNull();
    expect(onFinalizeSlot).not.toHaveBeenCalled();
  });

  it('passes the exact duration to the lock callback when a full window fits', () => {
    const onFinalizeSlot = vi.fn();
    render(
      h(HeatmapGrid, {
        poll: makePoll({ durationMinutes: 45, endHour: 11 }),
        onFinalizeSlot,
        activeParticipantFilter: null,
        onSelectParticipantFilter: () => {},
      })
    );

    fireEvent.click(document.getElementById('slot-2026-10-01-09:00') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Agree on this timing' }));

    expect(onFinalizeSlot).toHaveBeenCalledWith('2026-10-01', '09:00', '09:45');
  });
});
