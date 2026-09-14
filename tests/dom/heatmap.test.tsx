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
  it('publishes grouped calendar surfaces with decorative icons without changing labels', () => {
    render(h(HeatmapGrid, {
      poll: makePoll(),
      gridInterval: 30,
      activeParticipantFilter: null,
      onSelectParticipantFilter: () => {},
    }));

    const panel = document.querySelector<HTMLElement>('[data-visual-group="calendar-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('svg.lucide-calendar-days[aria-hidden="true"]')).not.toBeNull();
    expect(document.querySelector('[data-visual-group="calendar-tools"]')).not.toBeNull();
    expect(document.querySelector('[data-visual-group="selected-time"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Find the overlap' })).toBeTruthy();
    expect(document.getElementById('slot-2026-10-01-09:00')?.getAttribute('aria-label')).toContain(
      '1 of 1 available'
    );
  });

  it('keeps the selected inspector pinned while hovering another cell', () => {
    const poll = makePoll({ endHour: 11 });
    render(h(HeatmapGrid, {
      poll, gridInterval: 30, activeParticipantFilter: null, onSelectParticipantFilter: () => {},
    }));

    fireEvent.click(document.getElementById('slot-2026-10-01-09:00') as HTMLElement);
    const inspector = document.querySelector<HTMLElement>('[data-selected-slot]');
    expect(inspector?.dataset.selectedSlot).toBe('2026-10-01T09:00');
    const selectedDetail = inspector?.textContent;

    fireEvent.mouseEnter(document.getElementById('slot-2026-10-01-09:30') as HTMLElement);
    expect(inspector?.dataset.selectedSlot).toBe('2026-10-01T09:00');
    expect(inspector?.textContent).toBe(selectedDetail);
  });

  it('shows a true empty state instead of a zero-count heatmap before responses', () => {
    render(h(HeatmapGrid, {
      poll: makePoll({ participants: [] }),
      gridInterval: 30,
      activeParticipantFilter: null,
      onSelectParticipantFilter: () => {},
    }));

    expect(screen.getByText(/No responses yet/i)).toBeTruthy();
    expect(document.querySelector('tbody')).toBeNull();
    expect(document.body.textContent).not.toContain('0 of 0');
  });

  it('exposes the selected detail to keyboard focus without requiring a pointer hover', () => {
    render(h(HeatmapGrid, {
      poll: makePoll({ endHour: 11 }),
      gridInterval: 30,
      onFinalizeSlot: vi.fn(),
      activeParticipantFilter: null,
      onSelectParticipantFilter: () => {},
    }));

    const cell = document.getElementById('slot-2026-10-01-09:00') as HTMLElement;
    fireEvent.focus(cell);

    const inspector = document.querySelector<HTMLElement>('[data-selected-slot]');
    expect(inspector?.dataset.selectedSlot).toBe('2026-10-01T09:00');
    expect(inspector?.getAttribute('aria-label')).toMatch(/Selected time/i);
  });

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

  it('keeps the only finalization CTA in a dock after the main layout with its exact window summary', () => {
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

    const dock = document.querySelector<HTMLElement>('[data-action-dock]');
    const finalize = screen.getByRole('button', { name: 'Agree on this timing' });
    expect(dock).toBeTruthy();
    expect(finalize.closest('[data-action-dock]')).toBe(dock);
    expect(finalize.closest('.d-calendar-inspector')).toBeNull();
    expect(document.querySelectorAll('#quick-finalize-hover-slot')).toHaveLength(1);
    expect(dock?.querySelector('[data-finalize-date]')?.getAttribute('data-finalize-date')).toBe('2026-10-01');
    expect(dock?.querySelector('[data-finalize-date]')?.textContent).toContain('Oct 1');
    expect(dock?.querySelector('[data-meeting-window-range]')?.textContent).toContain('9:00 AM – 9:45 AM');
    expect(dock?.querySelector('[data-meeting-window-count]')?.textContent).toContain('1 of 1 available for full meeting');
  });

  it('does not render a finalization dock without a pinned valid meeting window', () => {
    const onFinalizeSlot = vi.fn();
    render(
      h(HeatmapGrid, {
        poll: makePoll(),
        onFinalizeSlot,
        activeParticipantFilter: null,
        onSelectParticipantFilter: () => {},
      })
    );

    expect(document.querySelector('[data-action-dock]')).toBeNull();
    fireEvent.click(document.getElementById('slot-2026-10-01-09:30') as HTMLElement);
    expect(document.querySelector('[data-action-dock]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agree on this timing' })).toBeNull();
  });

  it('previews the full meeting window and attendance before finalization', () => {
    const onFinalizeSlot = vi.fn();
    const poll = makePoll({
      durationMinutes: 60,
      endHour: 11,
      participants: [
        makePoll().participants[0],
        {
          id: 'b',
          name: 'Ben',
          timezone: 'UTC',
          updatedAt: '',
          availability: {
            '2026-10-01T09:00': 'available',
            '2026-10-01T09:30': 'unavailable',
          },
        },
      ],
    });

    render(
      h(HeatmapGrid, {
        poll,
        gridInterval: 30,
        onFinalizeSlot,
        activeParticipantFilter: null,
        onSelectParticipantFilter: () => {},
      })
    );

    fireEvent.click(document.getElementById('slot-2026-10-01-09:00') as HTMLElement);

    expect(screen.getByText('Full meeting window')).toBeTruthy();
    expect(document.querySelector('[data-meeting-window-range]')?.textContent).toContain('9:00 AM – 10:00 AM');
    expect(document.querySelector('[data-meeting-window-count]')?.textContent).toContain(
      '1 of 2 available for full meeting'
    );
    expect(onFinalizeSlot).not.toHaveBeenCalled();
  });
});
