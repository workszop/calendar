import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AvailabilityPainter } from '../../src/components/AvailabilityPainter';
import { TimeZoneNote } from '../../src/components/TimeZoneNote';
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
  onSaveAvailability = vi.fn().mockResolvedValue(undefined),
  ownParticipantId?: string
) {
  return {
    ...render(
      h(AvailabilityPainter, {
        poll,
        gridInterval,
        onSaveAvailability,
        ownParticipantId,
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
  it('publishes the answer grid visual group with a decorative calendar icon', () => {
    renderPainter(makePoll(), 30);

    const grid = document.querySelector<HTMLElement>(
      '[data-answer-grid][data-visual-group="answer-calendar"]'
    );
    expect(grid).not.toBeNull();
    expect(grid?.querySelector('svg.lucide-calendar-days[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'When can you make it?' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Available' })).toBeTruthy();
  });

  it('starts with an Available task grid and places identity and save after it', () => {
    renderPainter(makePoll(), 30);

    const grid = document.querySelector<HTMLElement>('[data-answer-grid]');
    const footer = document.querySelector<HTMLElement>('[data-answer-footer]');
    expect(grid).toBeTruthy();
    expect(footer).toBeTruthy();
    expect(Boolean(grid && footer && (grid.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    expect(screen.getByRole('radio', { name: 'Available' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/When can you make it\?/i)).toBeTruthy();
  });

  it('keeps the name and save action in one persistent dock while email stays in normal flow', () => {
    renderPainter(makePoll(), 30);

    const form = document.querySelector<HTMLFormElement>('[data-answer-footer]');
    const dock = document.querySelector<HTMLElement>('[data-action-dock]');
    const name = screen.getByLabelText(/Your Name/);
    const email = screen.getByLabelText(/Your Email/);
    const save = screen.getByRole('button', { name: 'Save My Availability' });

    expect(form).toBeTruthy();
    expect(dock).toBeTruthy();
    expect(name.closest('[data-action-dock]')).toBe(dock);
    expect(save.closest('[data-action-dock]')).toBe(dock);
    expect(email.closest('[data-action-dock]')).toBeNull();
    expect(email.closest('form')).toBe(form);
    expect(dock?.closest('form')).toBe(form);
    expect(document.querySelectorAll('[data-action-dock]')).toHaveLength(1);
  });

  it('blocks malformed optional email before submitting from the dock', () => {
    const { onSaveAvailability } = renderPainter(makePoll(), 30);
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Ada' } });
    const email = screen.getByLabelText(/Your Email/) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    expect(email.validity.typeMismatch).toBe(true);
    expect(onSaveAvailability).not.toHaveBeenCalled();
  });

  it('focuses the name field when save validation fails in the dock', () => {
    renderPainter(makePoll(), 30);

    const name = screen.getByLabelText(/Your Name/) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));

    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
    expect(screen.getByRole('alert').textContent).toContain('Enter your name to save your availability.');
  });

  it('keeps nuance tools disclosed and publishes explicit save state', async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveAvailability = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      })
    );
    renderPainter(makePoll(), 30, onSaveAvailability);

    expect(screen.queryByRole('button', { name: 'Preferred' })).toBeNull();
    fireEvent.click(screen.getByText('More answer options'));
    expect(screen.getByRole('radio', { name: 'Preferred' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'New Person' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    expect(document.querySelector('[data-answer-footer]')?.getAttribute('data-save-state')).toBe('saving');

    resolveSave?.();
    await waitFor(() => expect(document.querySelector('[data-answer-footer]')?.getAttribute('data-save-state')).toBe('saved'));
  });

  it('focuses the selected nuance brush after opening its disclosure with the keyboard', async () => {
    renderPainter(makePoll(), 30);

    const available = screen.getByRole('radio', { name: 'Available' });
    available.focus();
    fireEvent.keyDown(available, { key: 'ArrowRight' });

    await waitFor(() => {
      const preferred = screen.getByRole('radio', { name: 'Preferred' });
      expect(preferred.closest('details')?.hasAttribute('open')).toBe(true);
      expect(preferred).toBe(document.activeElement);
    });
  });

  it('preserves finalized answers when Select All is used before saving', async () => {
    const poll = makePoll({
      endHour: 10,
      finalizedSlot: {
        date: '2026-10-01',
        startTime: '09:00',
        endTime: '09:30',
        confirmedBy: 'Ada',
        confirmedAt: '',
      },
      participants: [
        {
          id: 'participant-1',
          name: 'Bob',
          timezone: 'UTC',
          updatedAt: '',
          availability: {
            [key('09:00')]: 'preferred',
            [key('09:30')]: 'unavailable',
          },
        },
      ],
    });
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(poll, 30, onSaveAvailability, 'participant-1');

    await waitFor(() => expect(cell('09:00').dataset.status).toBe('preferred'));
    fireEvent.click(screen.getByText('Quick fill tools'));
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));

    await waitFor(() => expect(onSaveAvailability).toHaveBeenCalledOnce());
    expect(onSaveAvailability.mock.calls[0]?.[2]).toEqual({
      [key('09:00')]: 'preferred',
      [key('09:30')]: 'available',
    });
  });

  it('keeps loaded answers when a stroke starts on a finalized cell', async () => {
    const poll = makePoll({
      endHour: 10,
      finalizedSlot: {
        date: '2026-10-01',
        startTime: '09:00',
        endTime: '09:30',
        confirmedBy: 'Ada',
        confirmedAt: '',
      },
      participants: [
        {
          id: 'participant-1',
          name: 'Bob',
          timezone: 'UTC',
          updatedAt: '',
          availability: { [key('09:30')]: 'preferred' },
        },
      ],
    });
    renderPainter(poll, 30, undefined, 'participant-1');

    await waitFor(() => expect(cell('09:30').dataset.status).toBe('preferred'));
    finishPointerStroke(cell('09:00'));

    expect(cell('09:30').dataset.status).toBe('preferred');
  });

  it("never loads another participant's answers when their name is typed", async () => {
    const poll = makePoll({
      endHour: 10,
      participants: [
        {
          id: 'participant-anna',
          name: 'Anna',
          timezone: 'UTC',
          updatedAt: '',
          availability: { [key('09:30')]: 'preferred' },
        },
      ],
    });
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(poll, 30, onSaveAvailability);

    finishPointerStroke(cell('09:00'));
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Anna' } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cell('09:30').dataset.status).toBe('none');
    expect(cell('09:00').dataset.status).toBe('available');
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(onSaveAvailability).toHaveBeenCalledOnce());
    // No participant id: saving creates a new response instead of replacing Anna's.
    expect(onSaveAvailability).toHaveBeenCalledWith('Anna', '', { [key('09:00')]: 'available' }, undefined);
  });

  it("loads this device's own saved response by id and updates it", async () => {
    const poll = makePoll({
      endHour: 10,
      participants: [
        {
          id: 'participant-me',
          name: 'Me',
          timezone: 'UTC',
          updatedAt: '',
          availability: { [key('09:30')]: 'if_needed' },
        },
      ],
    });
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(poll, 30, onSaveAvailability, 'participant-me');

    await waitFor(() => expect(cell('09:30').dataset.status).toBe('if_needed'));
    expect((screen.getByLabelText(/Your Name/) as HTMLInputElement).value).toBe('Me');
    fireEvent.click(screen.getByRole('button', { name: 'Save My Availability' }));
    await waitFor(() => expect(onSaveAvailability).toHaveBeenCalledOnce());
    expect(onSaveAvailability.mock.calls[0]?.[3]).toBe('participant-me');
  });

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
    renderPainter(poll, 60, undefined, 'participant-1');

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

  it('lets touch drags paint cells while the time column keeps native scrolling', () => {
    renderPainter(makePoll(), 30);

    expect(cell('09:00').style.touchAction).toBe('none');
    const timeCell = [...document.querySelectorAll<HTMLElement>('[data-answer-table] tbody td')].find(
      (element) => element.textContent === '9:00 AM'
    );
    expect(timeCell).toBeTruthy();
    expect(timeCell!.style.touchAction).toBe('');
  });

  it('paints a vertical touch drag through the grid hit-testing', async () => {
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(makePoll(), 30, onSaveAvailability);
    const table = document.querySelector<HTMLTableElement>('[data-answer-table] table');
    expect(table).toBeTruthy();

    const originalElementFromPoint = document.elementFromPoint;
    const elementFromPoint = vi.fn<(x: number, y: number) => Element | null>();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
    try {
      fireEvent.pointerDown(cell('09:00'), { pointerId: 7, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 });
      // The label inside the cell is what a finger lands on.
      elementFromPoint.mockReturnValue(cell('10:00').querySelector('span') ?? cell('10:00'));
      fireEvent.pointerMove(table!, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 90 });
      expect(elementFromPoint).toHaveBeenCalledWith(10, 90);
      expect(cell('09:30').dataset.status).toBe('available');
      expect(cell('10:00').dataset.status).toBe('available');
      fireEvent.pointerUp(window, { pointerId: 7, pointerType: 'touch' });
    } finally {
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: originalElementFromPoint });
    }

    await savePainter();
    expect(onSaveAvailability.mock.calls[0]?.[2]).toEqual({
      [key('09:00')]: 'available',
      [key('09:30')]: 'available',
      [key('10:00')]: 'available',
    });
  });

  it('names the poll time zone on the answer grid', () => {
    renderPainter(makePoll({ timezone: 'Europe/Warsaw' }), 30);

    const grid = document.querySelector<HTMLElement>('[data-answer-grid]');
    expect(grid?.dataset.pollTimezone).toBe('Europe/Warsaw');
    expect(grid?.querySelector('[data-timezone-note]')?.textContent).toContain('Times in Europe/Warsaw');
  });

  it('aligns an hourly view across days that start on different half-hours', async () => {
    const onSaveAvailability = vi.fn().mockResolvedValue(undefined);
    renderPainter(
      makePoll({
        dates: ['2026-10-01', '2026-10-02'],
        proposedSlots: { '2026-10-01': ['09:00', '09:30'], '2026-10-02': ['09:30', '10:00', '10:30'] },
      }),
      60,
      onSaveAvailability
    );

    const rows = [...document.querySelectorAll('[data-answer-table] tbody tr')];
    expect(rows.map((row) => row.querySelector('td')?.textContent)).toEqual(['9:00 AM', '10:00 AM']);
    expect(rows[0].querySelectorAll('[data-slot-key]')).toHaveLength(2);
    const partial = cell('09:00', '2026-10-02');
    expect(partial.dataset.coveredSlots).toBe('09:30');
    expect(partial.getAttribute('aria-label')).toMatch(/9:30 AM.*10:00 AM/);

    finishPointerStroke(partial);
    await savePainter();
    expect(onSaveAvailability.mock.calls[0]?.[2]).toEqual({ [key('09:30', '2026-10-02')]: 'available' });
  });
});

describe('TimeZoneNote', () => {
  it('adds the offset hint only for a viewer in another zone', () => {
    const summer = new Date('2026-07-01T12:00:00Z');
    const { rerender } = render(h(TimeZoneNote, { timeZone: 'Europe/Warsaw', viewerTimeZone: 'Europe/Warsaw', now: summer }));
    expect(document.querySelector('[data-timezone-note]')?.textContent).toBe('Times in Europe/Warsaw');

    rerender(h(TimeZoneNote, { timeZone: 'Europe/Warsaw', viewerTimeZone: 'America/Chicago', now: summer }));
    expect(document.querySelector('[data-timezone-note]')?.textContent).toBe(
      'Times in Europe/Warsaw (your time is 7 h earlier)'
    );
  });
});
