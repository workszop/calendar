import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AvailabilityPainter } from '../../src/components/AvailabilityPainter';
import type { Poll } from '../../src/types';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 'poll_painter',
    title: 'Painter',
    description: '',
    durationMinutes: 60,
    timezone: 'UTC',
    dates: ['2026-10-01'],
    startHour: 9,
    endHour: 11,
    slotInterval: 30,
    creatorName: 'Ada',
    createdAt: '',
    finalizedSlot: null,
    participants: [],
    ...overrides,
  };
}

function key(time: string, date = '2026-10-01'): string {
  return `${date}T${time}`;
}

function cell(time: string, date = '2026-10-01'): HTMLButtonElement {
  const result = document.querySelector<HTMLButtonElement>(`[data-slot-key="${key(time, date)}"]`);
  if (!result) throw new Error(`Missing painter cell ${key(time, date)}`);
  return result;
}

function renderPainter(
  poll: Poll,
  gridInterval: 30 | 60,
  onSaveAvailability = vi.fn().mockResolvedValue(undefined)
) {
  return {
    ...render(
      h(AvailabilityPainter, {
        poll,
        gridInterval,
        onSaveAvailability,
      })
    ),
    onSaveAvailability,
  };
}

function finishPointerStroke(target: HTMLElement) {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'mouse', button: 0 });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse', button: 0 });
}

async function savePainter() {
  fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'New Person' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save My Availability' })).toBeTruthy());
}

describe('AvailabilityPainter display interval', () => {
  it('renders a Mixed hourly block when atomic answers differ, with explicit coverage metadata', async () => {
    const poll = makePoll({
      endHour: 10,
      participants: [
        {
          id: 'participant-1',
          name: 'Bob',
          timezone: 'UTC',
          updatedAt: '',
          availability: { [key('09:00')]: 'available' },
        },
      ],
    });
    localStorage.setItem('timesync_user_name', 'Bob');
    renderPainter(poll, 60);

    await waitFor(() => expect(cell('09:00').dataset.status).toBe('mixed'));

    expect(cell('09:00').textContent).toContain('Mixed');
    expect(cell('09:00').getAttribute('aria-label')).toMatch(/9:00 AM.*10:00 AM/);
    expect(cell('09:00').dataset.coveredSlots).toBe('09:00,09:30');
  });

  it('paints and erases every atomic slot covered by an hourly block', async () => {
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(makePoll({ endHour: 10 }), 60, onSaveAvailability);

    finishPointerStroke(cell('09:00'));
    expect(cell('09:00').dataset.status).toBe('available');

    finishPointerStroke(cell('09:00'));
    expect(cell('09:00').dataset.status).toBe('none');

    await savePainter();
    expect(onSaveAvailability).toHaveBeenCalledWith('New Person', '', {}, undefined);
  });

  it('preserves atomic votes while flipping 60-minute, 30-minute, then 60-minute views', () => {
    const poll = makePoll({ endHour: 10 });
    const view = renderPainter(poll, 60);

    finishPointerStroke(cell('09:00'));
    expect(cell('09:00').dataset.status).toBe('available');

    view.rerender(h(AvailabilityPainter, {
      poll,
      gridInterval: 30,
      onSaveAvailability: view.onSaveAvailability,
    }));
    expect(cell('09:00').dataset.status).toBe('available');
    expect(cell('09:30').dataset.status).toBe('available');

    view.rerender(h(AvailabilityPainter, {
      poll,
      gridInterval: 60,
      onSaveAvailability: view.onSaveAvailability,
    }));
    expect(cell('09:00').dataset.status).toBe('available');
    expect(cell('09:00').dataset.coveredSlots).toBe('09:00,09:30');
  });

  it('cancels an in-flight stroke when the display interval changes', () => {
    const poll = makePoll({ endHour: 10 });
    const view = renderPainter(poll, 60);
    const block = cell('09:00');

    fireEvent.pointerDown(block, { pointerId: 1, pointerType: 'mouse', button: 0 });
    view.rerender(h(AvailabilityPainter, {
      poll,
      gridInterval: 30,
      onSaveAvailability: view.onSaveAvailability,
    }));
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse', button: 0 });

    expect(cell('09:00').dataset.status).toBe('available');
    expect(cell('09:30').dataset.status).toBe('available');
  });

  it('keeps the final partial hour inside the organizer window and paints only its atomic slot', async () => {
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(makePoll({ endHour: 10.5 }), 60, onSaveAvailability);

    expect(cell('10:00').dataset.coveredSlots).toBe('10:00');
    expect(cell('10:00').getAttribute('aria-label')).toMatch(/10:00 AM.*10:30 AM/);
    finishPointerStroke(cell('10:00'));

    await savePainter();
    expect(onSaveAvailability.mock.calls[0]?.[2]).toEqual({ [key('10:00')]: 'available' });
  });

  it('fills a displayed day by writing all underlying atomic slots', async () => {
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(makePoll(), 60, onSaveAvailability);

    fireEvent.click(screen.getByRole('button', { name: /Answer all of/ }));
    await savePainter();

    expect(onSaveAvailability.mock.calls[0]?.[2]).toEqual({
      [key('09:00')]: 'available',
      [key('09:30')]: 'available',
      [key('10:00')]: 'available',
      [key('10:30')]: 'available',
    });
  });

  it('fills cells a fast drag skipped over', async () => {
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(makePoll(), 30, onSaveAvailability);

    // The pointer jumps from 09:00 straight to 10:30; 09:30 and 10:00 never get an event.
    fireEvent.pointerDown(cell('09:00'), { pointerId: 1, pointerType: 'mouse', button: 0 });
    // React derives pointerenter from pointerout; jsdom has no PointerEvent, so
    // pointerType is attached by hand.
    const out = new MouseEvent('pointerout', { bubbles: true, relatedTarget: cell('10:30') });
    Object.defineProperty(out, 'pointerType', { value: 'mouse' });
    fireEvent(cell('09:00'), out);
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse', button: 0 });

    await savePainter();
    expect(onSaveAvailability.mock.calls[0]?.[2]).toEqual({
      [key('09:00')]: 'available',
      [key('09:30')]: 'available',
      [key('10:00')]: 'available',
      [key('10:30')]: 'available',
    });
  });

  it('supports keyboard painting and clearing for an hourly block', () => {
    renderPainter(makePoll({ endHour: 10 }), 60);
    const block = cell('09:00');

    fireEvent.keyDown(block, { key: 'Enter' });
    expect(block.dataset.status).toBe('available');
    fireEvent.keyDown(block, { key: ' ' });
    expect(block.dataset.status).toBe('none');
  });
});
