import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExtendPollModal, findDateWithoutMeetingFitLocal } from '../../src/components/ExtendPollModal';
import { formatDateHeading, toDateStr } from '../../src/utils/calendar';
import type { Poll } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Dates relative to today, so the calendar's "no past dates" rule never bites.
const day = (offset: number) => {
  const d = new Date();
  return toDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset));
};

function makePoll(overrides: Partial<Poll> = {}): Poll {
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
    ...overrides,
  };
}

function openOn(poll: Poll, onAddDates = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  render(h(ExtendPollModal, { isOpen: true, onClose, poll, onAddDates }));
  return onAddDates;
}

// The calendar opens on the month of the poll's last date; step forward (or
// back) until the date's month is shown.
function dateButton(date: string, direction: 'Next month' | 'Previous month' = 'Next month'): HTMLButtonElement {
  for (let i = 0; i < 16; i++) {
    const found = document.querySelector<HTMLButtonElement>(`#toggle-date-${date}`);
    if (found) return found;
    fireEvent.click(screen.getByRole('button', { name: direction }));
  }
  throw new Error(`Missing calendar day ${date}`);
}

function cell(date: string, time: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[data-proposal-grid] [data-slot-key="${date}T${time}"]`);
  if (!found) throw new Error(`Missing proposal cell ${date}T${time}`);
  return found;
}

function propose(date: string, times: string[]) {
  times.forEach((time) => fireEvent.click(cell(date, time)));
}

const submit = () => fireEvent.click(document.querySelector<HTMLButtonElement>('#add-dates-submit-btn')!);

describe('ExtendPollModal', () => {
  it('locks existing dates and starts new dates empty inside the poll hours', async () => {
    const poll = makePoll();
    const onAddDates = openOn(poll);

    const existing = dateButton(poll.dates[0]);
    expect(existing.dataset.locked).toBe('true');
    fireEvent.click(existing);
    expect(document.querySelector('[data-proposal-grid] [data-slot-key]')).toBeNull();

    fireEvent.click(dateButton(day(3)));
    const cells = [...document.querySelectorAll<HTMLElement>('[data-proposal-grid] [data-slot-key]')];
    expect(cells.map((c) => c.dataset.slotKey)).toEqual([
      `${day(3)}T10:00`, `${day(3)}T10:30`, `${day(3)}T11:00`, `${day(3)}T11:30`,
    ]);
    expect(cells.every((c) => c.dataset.selected === 'false')).toBe(true);

    propose(day(3), ['10:00', '11:30']);
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 Date' }));
    await waitFor(() => expect(onAddDates).toHaveBeenCalled());
    expect(onAddDates).toHaveBeenCalledWith([day(3)], { [day(3)]: ['10:00', '11:30'] });
  });

  it('offers the full day, 00:00 to 24:00, and proposes an early hour', async () => {
    const onAddDates = openOn(makePoll());
    fireEvent.click(dateButton(day(3)));

    const start = screen.getByLabelText('Show earlier from') as HTMLSelectElement;
    const end = screen.getByLabelText('Show later until') as HTMLSelectElement;
    expect(start.options[0].value).toBe('0');
    expect(end.options[end.options.length - 1].value).toBe('24');

    fireEvent.change(start, { target: { value: '5' } });
    propose(day(3), ['05:00']);
    submit();
    await waitFor(() => expect(onAddDates).toHaveBeenCalled());
    expect(onAddDates).toHaveBeenCalledWith([day(3)], { [day(3)]: ['05:00'] });
  });

  it('requires a new date and shows server errors inline', async () => {
    const onAddDates = vi.fn().mockRejectedValue(new Error('Re-open voting before adding dates.'));
    openOn(makePoll(), onAddDates);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    submit();
    expect(await screen.findByText('Select at least one new date.')).toBeTruthy();
    expect(onAddDates).not.toHaveBeenCalled();

    fireEvent.click(dateButton(day(4)));
    propose(day(4), ['10:00']);
    submit();
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Re-open voting before adding dates.')).toBeTruthy();
  });

  it('refuses a new date that proposes no time', async () => {
    const onAddDates = openOn(makePoll());
    fireEvent.click(dateButton(day(3)));
    submit();
    expect(await screen.findByText(`${formatDateHeading(day(3)).full}: propose at least one time.`)).toBeTruthy();
    expect(onAddDates).not.toHaveBeenCalled();
  });

  it('requires a back-to-back run covering the meeting length on every new date', async () => {
    const onAddDates = openOn(makePoll({ durationMinutes: 60 }));
    fireEvent.click(dateButton(day(3)));
    propose(day(3), ['10:00', '11:00']);
    submit();
    const message = `${formatDateHeading(day(3)).full}: propose at least 60 minutes of back-to-back times.`;
    expect(await screen.findByText(message)).toBeTruthy();
    expect(onAddDates).not.toHaveBeenCalled();

    propose(day(3), ['10:30']);
    expect(screen.queryByText(message)).toBeNull();
    submit();
    await waitFor(() => expect(onAddDates).toHaveBeenCalledWith([day(3)], { [day(3)]: ['10:00', '10:30', '11:00'] }));
  });

  it('keeps the 60-date limit', async () => {
    const filler = Array.from({ length: 59 }, (_, i) => `2020-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`);
    const onAddDates = openOn(makePoll({ dates: [...filler, day(2)] }));
    fireEvent.click(dateButton(day(3)));
    propose(day(3), ['10:00']);
    submit();
    expect(await screen.findByText('A poll can have at most 60 dates.')).toBeTruthy();
    expect(onAddDates).not.toHaveBeenCalled();
  });

  it('keeps the one-year limit', async () => {
    const onAddDates = openOn(makePoll());
    fireEvent.click(dateButton(day(400)));
    propose(day(400), ['10:00']);
    submit();
    expect(await screen.findByText('Choose dates within the next year.')).toBeTruthy();
    expect(onAddDates).not.toHaveBeenCalled();
  });

  it('blocks past dates', () => {
    openOn(makePoll());
    const past = dateButton(day(-1), 'Previous month');
    expect(past.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(past);
    expect(past.getAttribute('aria-pressed')).toBe('false');
  });

  it('cannot be closed while the dates are being added', async () => {
    let resolve!: () => void;
    const onAddDates = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const onClose = vi.fn();
    openOn(makePoll(), onAddDates, onClose);
    fireEvent.click(dateButton(day(3)));
    propose(day(3), ['10:00']);
    submit();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adding...' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps Tab inside the nested copy-times dialog', () => {
    // jsdom has no layout; treat every attached element as visible to the trap.
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
      return this.parentElement;
    });
    openOn(makePoll());
    [3, 4, 5].forEach((offset) => fireEvent.click(dateButton(day(offset))));
    fireEvent.click(document.querySelector<HTMLButtonElement>(`[data-copy-source-date="${day(3)}"]`)!);

    const copyDialog = screen.getByRole('dialog', { name: 'Copy times to…' });
    const firstDestination = within(copyDialog).getAllByRole('checkbox')[0];
    firstDestination.focus();
    fireEvent.keyDown(firstDestination, { key: 'Tab' });
    expect(copyDialog.contains(document.activeElement)).toBe(true);
  });
});

describe('findDateWithoutMeetingFitLocal', () => {
  const poll = makePoll({ durationMinutes: 60, dates: ['2026-10-01'] });

  it('accepts a date with a long enough run, even beside gaps', () => {
    expect(
      findDateWithoutMeetingFitLocal(poll, ['2026-10-05'], { '2026-10-05': ['05:00', '08:00', '08:30'] })
    ).toBeUndefined();
  });

  it('returns the first date whose runs are all too short', () => {
    expect(
      findDateWithoutMeetingFitLocal(poll, ['2026-10-05', '2026-10-06', '2026-10-07'], {
        '2026-10-05': ['09:00', '09:30'],
        '2026-10-06': ['09:00', '10:00', '11:00'],
        '2026-10-07': [],
      })
    ).toBe('2026-10-06');
  });

  it('ignores the poll-wide hours and day overrides of existing dates', () => {
    const narrow = makePoll({ durationMinutes: 30, startHour: 10, endHour: 11, dayHours: { '2026-10-05': { startHour: 10, endHour: 11 } } });
    expect(findDateWithoutMeetingFitLocal(narrow, ['2026-10-05'], { '2026-10-05': ['00:00'] })).toBeUndefined();
  });
});
