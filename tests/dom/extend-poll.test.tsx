import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExtendPollModal } from '../../src/components/ExtendPollModal';
import { toDateStr } from '../../src/utils/calendar';
import type { Poll } from '../../src/types';

afterEach(cleanup);

// Dates relative to today, so the calendar's "no past dates" rule never bites.
const day = (offset: number) => {
  const d = new Date();
  return toDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset));
};

function makePoll(): Poll {
  return {
    id: 'p1',
    title: 'Team sync',
    description: '',
    durationMinutes: 30,
    timezone: 'UTC',
    dates: [day(2)],
    startHour: 10,
    endHour: 12,
    slotInterval: 30,
    creatorName: 'Ada',
    createdAt: '',
    finalizedSlot: null,
    participants: [],
  };
}

function openOn(poll: Poll, onAddDates = vi.fn().mockResolvedValue(undefined)) {
  render(h(ExtendPollModal, { isOpen: true, onClose: () => {}, poll, onAddDates }));
  return onAddDates;
}

// The calendar opens on the month of the poll's last date; step forward if a
// date sits in the next month.
function dateButton(date: string): HTMLButtonElement {
  for (let i = 0; i < 2; i++) {
    const found = document.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
    if (found) return found;
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  }
  throw new Error(`Missing calendar day ${date}`);
}

describe('ExtendPollModal', () => {
  it('locks existing dates and adds new ones with the poll hours as default', async () => {
    const poll = makePoll();
    const onAddDates = openOn(poll);

    const existing = dateButton(poll.dates[0]);
    expect(existing.dataset.locked).toBe('true');
    fireEvent.click(existing);
    expect(screen.queryByRole('button', { name: /Toggle all proposed times/ })).toBeNull();

    fireEvent.click(dateButton(day(3)));
    const cells = [...document.querySelectorAll<HTMLElement>('[data-proposal-grid] [data-slot-key]')];
    expect(cells.map((c) => c.dataset.slotKey)).toEqual([
      `${day(3)}T10:00`, `${day(3)}T10:30`, `${day(3)}T11:00`, `${day(3)}T11:30`,
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 Date' }));
    await waitFor(() => expect(onAddDates).toHaveBeenCalled());
    expect(onAddDates).toHaveBeenCalledWith([day(3)], { [day(3)]: ['10:00', '10:30', '11:00', '11:30'] });
  });

  it('requires a new date and shows server errors inline', async () => {
    const onAddDates = vi.fn().mockRejectedValue(new Error('Re-open voting before adding dates.'));
    openOn(makePoll(), onAddDates);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: 'Add Dates' }));
    expect(await screen.findByText('Select at least one new date.')).toBeTruthy();
    expect(onAddDates).not.toHaveBeenCalled();

    fireEvent.click(dateButton(day(4)));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 Date' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Re-open voting before adding dates.')).toBeTruthy();
  });
});
