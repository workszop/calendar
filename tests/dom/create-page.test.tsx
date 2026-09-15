import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreatePollPage } from '../../src/components/CreatePollPage';
import { toDateStr } from '../../src/utils/calendar';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPage(
  onCreatePoll = vi.fn().mockResolvedValue(undefined),
  onBusyChange = vi.fn()
) {
  const onCancel = vi.fn();
  render(
    h(CreatePollPage, {
      onCancel,
      onCreatePoll,
      defaultTimezone: 'Europe/Warsaw',
      onBusyChange,
    })
  );
  return { onCancel, onCreatePoll, onBusyChange };
}

function todayPlus(offset: number): string {
  const today = new Date();
  return toDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
}

function proposalCell(date: string, time: string): HTMLButtonElement {
  const cell = document.querySelector<HTMLButtonElement>(
    `[data-proposal-grid] [data-slot-key="${date}T${time}"]`
  );
  if (!cell) throw new Error(`Missing proposal cell ${date}T${time}`);
  return cell;
}

function chooseNextThreeDates(): string[] {
  fireEvent.click(screen.getByRole('button', { name: 'Next 3 Days' }));
  const dates = [...document.querySelectorAll<HTMLElement>('[data-proposal-grid] [data-slot-key]')].map(
    (element) => element.dataset.slotKey!.slice(0, 10)
  );
  return [...new Set(dates)];
}

function fillSelectedDays() {
  const cells = [...document.querySelectorAll<HTMLButtonElement>('[data-proposal-grid] [data-slot-key]')];
  const dates = [...new Set(cells.map((cell) => cell.dataset.slotKey!.slice(0, 10)))];
  for (const date of dates) {
    for (const cell of cells.filter((candidate) => candidate.dataset.slotKey!.startsWith(`${date}T`))) {
      fireEvent.click(cell);
    }
  }
}

function clearDay(date: string) {
  const cells = document.querySelectorAll<HTMLButtonElement>(
    `[data-proposal-grid] [data-slot-key^="${date}T"]`
  );
  for (const cell of cells) fireEvent.click(cell);
}

describe('CreatePollPage', () => {
  it('publishes the visual grouping contract for the required create sections', () => {
    renderPage();

    const meetingDetails = document.querySelector<HTMLElement>(
      '[data-visual-group="meeting-details"]'
    );
    const dateSelection = document.querySelector<HTMLElement>(
      '[data-visual-group="date-selection"]'
    );
    const timeSelection = document.querySelector<HTMLElement>(
      '[data-visual-group="time-selection"]'
    );

    expect(meetingDetails).toBeTruthy();
    expect(meetingDetails?.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
    expect(dateSelection).toBeTruthy();
    expect(dateSelection?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(timeSelection).toBeTruthy();
  });

  it('shows name, duration and the candidate calendar in one initial view', () => {
    renderPage();

    expect(screen.getByLabelText(/Meeting name/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '60 minutes' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Proposed dates' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Proposed dates' }).getAttribute('data-calendar-mode')).toBe('responsive');
    expect(screen.queryByRole('navigation', { name: 'Poll creation steps' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Choose dates/ })).toBeNull();
    expect(document.querySelector('[data-step]')).toBeNull();
  });

  it('keeps optional metadata collapsed until requested', () => {
    renderPage();

    const disclosure = screen.getByText(/Add location, notes or organizer details/).closest('details');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText(/Add location, notes or organizer details/));
    expect(disclosure?.open).toBe(true);
    expect(screen.getByLabelText(/^Location/)).toBeTruthy();
  });

  it('keeps one fixed action dock in the current form', () => {
    renderPage();
    const form = document.querySelector('form');
    expect(form).toBeTruthy();
    expect(document.querySelectorAll('[data-action-dock]')).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('[data-primary-action]')?.closest('form')).toBe(form);
    expect(screen.getByRole('button', { name: 'Create poll' })).toBeTruthy();
  });

  it('starts selected dates with no proposals and exposes the per-day editor directly', () => {
    renderPage();

    const dates = chooseNextThreeDates();
    expect(dates).toHaveLength(3);
    expect(document.querySelector('[data-day-times-editor]')).toBeTruthy();
    expect(proposalCell(dates[0], '09:00').dataset.selected).toBe('false');
    expect(screen.getByLabelText('Show earlier from')).toBeTruthy();
    expect(screen.getByLabelText('Show later until')).toBeTruthy();
  });

  it('keeps optional metadata and duration in the exact create payload', async () => {
    const onCreatePoll = vi.fn().mockResolvedValue(undefined);
    renderPage(onCreatePoll);
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Design review' } });
    fireEvent.click(screen.getByRole('button', { name: '90 minutes' }));
    fireEvent.click(screen.getByText(/Add location, notes or organizer details/));
    fireEvent.change(screen.getByLabelText(/^Location/), { target: { value: 'Room 4' } });
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: 'Bring the roadmap' } });
    fireEvent.change(screen.getByLabelText(/^Your name/), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/^Your email/), { target: { value: 'ada@example.com' } });
    chooseNextThreeDates();
    fillSelectedDays();

    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));
    await waitFor(() => expect(onCreatePoll).toHaveBeenCalledTimes(1));
    expect(onCreatePoll.mock.calls[0][0]).toMatchObject({
      title: 'Design review',
      description: 'Bring the roadmap',
      location: 'Room 4',
      durationMinutes: 90,
      creatorName: 'Ada',
      creatorEmail: 'ada@example.com',
      timezone: 'Europe/Warsaw',
    });
  });

  it('validates the title and dates without changing views', () => {
    const { onCreatePoll } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));

    expect(screen.getByText('Give the meeting a title.')).toBeTruthy();
    expect(screen.getByText('Select at least one candidate date.')).toBeTruthy();
    expect(document.querySelector('[data-screen="create"]')).toBeTruthy();
    expect(onCreatePoll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText(/Meeting name/));
  });

  it('keeps focus in the title while typing clears its validation error', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));
    const titleInput = screen.getByLabelText(/Meeting name/);
    expect(document.activeElement).toBe(titleInput);

    fireEvent.change(titleInput, { target: { value: 'P' } });

    expect(screen.queryByText('Give the meeting a title.')).toBeNull();
    expect(screen.getByText('Select at least one candidate date.')).toBeTruthy();
    expect(document.activeElement).toBe(titleInput);
  });

  it('rejects a selected day with no proposed times', () => {
    const { onCreatePoll } = renderPage();
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Planning session' } });
    chooseNextThreeDates();
    fillSelectedDays();

    const [day] = [...document.querySelectorAll<HTMLElement>('[data-proposal-grid] [data-slot-key]')].map(
      (element) => element.dataset.slotKey!.slice(0, 10)
    );
    clearDay(day);
    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));

    expect(screen.getByRole('alert').textContent).toMatch(/propose at least one time/);
    expect(onCreatePoll).not.toHaveBeenCalled();
  });

  it('rejects a day whose proposed times cannot hold the meeting length and focuses the hours', () => {
    const { onCreatePoll } = renderPage();
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Planning session' } });
    const [day1, day2] = chooseNextThreeDates();
    fillSelectedDays();
    clearDay(day2);
    // Two separate half-hours never hold a 60-minute meeting.
    fireEvent.click(proposalCell(day2, '09:00'));
    fireEvent.click(proposalCell(day2, '11:00'));
    expect(proposalCell(day2, '09:00').dataset.selected).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('propose at least 60 minutes of back-to-back times.');
    expect(alert.textContent).not.toContain(day1);
    expect(document.activeElement?.id).toBe('create-page-start-hour');
    expect(onCreatePoll).not.toHaveBeenCalled();
  });

  it('accepts short runs once the meeting length fits them', async () => {
    const { onCreatePoll } = renderPage();
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Planning session' } });
    fireEvent.click(screen.getByRole('button', { name: '90 minutes' }));
    const [, day2] = chooseNextThreeDates();
    fillSelectedDays();
    clearDay(day2);
    fireEvent.click(proposalCell(day2, '09:00'));
    fireEvent.click(proposalCell(day2, '09:30'));

    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));
    expect(screen.getByRole('alert').textContent).toMatch(/at least 90 minutes/);

    fireEvent.click(screen.getByRole('button', { name: '60 minutes' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));
    await waitFor(() => expect(onCreatePoll).toHaveBeenCalledTimes(1));
  });

  it('preserves sparse proposals after a failed create and retries the same draft', async () => {
    const onCreatePoll = vi
      .fn()
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValueOnce(undefined);
    const { onBusyChange } = renderPage(onCreatePoll);
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Planning session' } });
    const [day1, day2, day3] = chooseNextThreeDates();
    fillSelectedDays();

    fireEvent.keyDown(proposalCell(day1, '09:00'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));

    await waitFor(() => expect(onCreatePoll).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('alert')).textContent).toContain('Server unavailable');
    expect(proposalCell(day1, '09:00').dataset.selected).toBe('false');
    expect(proposalCell(day2, '09:00').dataset.selected).toBe('true');
    expect(proposalCell(day3, '16:30').dataset.selected).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Create poll' }));
    await waitFor(() => expect(onCreatePoll).toHaveBeenCalledTimes(2));

    const payload = onCreatePoll.mock.calls[0][0];
    expect(payload).toMatchObject({
      title: 'Planning session',
      dates: [day1, day2, day3],
      slotInterval: 30,
      startHour: 9,
      endHour: 17,
    });
    expect(payload.proposedSlots[day1]).not.toContain('09:00');
    expect(payload.proposedSlots[day2]).toContain('09:00');
    expect(onBusyChange).toHaveBeenCalledWith(true);
    expect(onBusyChange).toHaveBeenCalledWith(false);
  });

  it('allows only one in-flight create and disables leaving while busy', async () => {
    let resolveCreate!: () => void;
    const onCreatePoll = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveCreate = resolve;
      })
    );
    const { onCancel } = renderPage(onCreatePoll);
    fireEvent.change(screen.getByLabelText(/Meeting name/), { target: { value: 'Busy guard' } });
    chooseNextThreeDates();
    fillSelectedDays();

    const create = screen.getByRole('button', { name: 'Create poll' });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: 'Back to meetings' }));

    expect(onCreatePoll).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect((document.querySelector('[data-primary-action]') as HTMLButtonElement).disabled).toBe(true);

    resolveCreate();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create poll' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('retains calendar keyboard navigation in the single view', () => {
    renderPage();
    const today = document.querySelector<HTMLButtonElement>(`[data-date="${todayPlus(0)}"]`);
    expect(today).toBeTruthy();
    fireEvent.keyDown(today!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(document.querySelector(`[data-date="${todayPlus(1)}"]`));
  });
});
