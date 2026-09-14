import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, useEffect } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { DayTimesEditor } from '../../src/components/DayTimesEditor';
import { useProposalDraft } from '../../src/hooks/useProposalDraft';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DATES = ['2026-10-01', '2026-10-02'];

function cell(date: string, time: string): HTMLButtonElement {
  const result = document.querySelector<HTMLButtonElement>(
    `[data-proposal-grid] [data-slot-key="${date}T${time}"]`
  );
  if (!result) throw new Error(`Missing editor cell ${date}T${time}`);
  return result;
}

function DraftHarness({ initiallyEmpty = true, dates = DATES }: { initiallyEmpty?: boolean; dates?: string[] }) {
  const draft = useProposalDraft(9, 17, initiallyEmpty);
  useEffect(() => {
    draft.setDates(dates);
  }, [dates]);
  return <DayTimesEditor draft={draft} idPrefix="day-times" />;
}

describe('useProposalDraft initially-empty mode', () => {
  it('leaves new days and newly visible rows empty without changing legacy mode', () => {
    const empty = renderHook(() => useProposalDraft(9, 17, true));
    act(() => empty.result.current.setDates([DATES[0]]));
    expect(empty.result.current.proposed[DATES[0]]).toEqual([]);

    act(() => empty.result.current.changeRange(8, 18));
    expect(empty.result.current.proposed[DATES[0]]).toEqual([]);
    expect(empty.result.current.gridTimes[0]).toBe('08:00');
    expect(empty.result.current.gridTimes.at(-1)).toBe('17:30');

    const legacy = renderHook(() => useProposalDraft(9, 17));
    act(() => legacy.result.current.setDates([DATES[0]]));
    expect(legacy.result.current.proposed[DATES[0]]).toHaveLength(16);
    act(() => legacy.result.current.changeRange(8, 18));
    expect(legacy.result.current.proposed[DATES[0]]).toHaveLength(20);
  });
});

describe('DayTimesEditor', () => {
  it('places the hour-window controls below the table and keeps instructions above it', () => {
    render(h(DraftHarness));
    const table = screen.getByRole('table', { name: 'Proposed times by day' });
    const controls = screen.getByLabelText('Show earlier from').closest('[data-range-controls]');
    expect(controls).not.toBeNull();
    expect(table.compareDocumentPosition(controls!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const instructions = document.getElementById('day-times-instructions')!;
    expect(instructions.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls?.textContent).toContain('Proposed times');
    expect(controls?.textContent).toContain('Expand the window to show more rows. New rows start unselected.');
    expect(screen.getByRole('group', { name: 'Proposed times' })).toBeTruthy();
    fireEvent.click(cell(DATES[0], '09:00'));
    fireEvent.change(screen.getByLabelText('Show earlier from'), { target: { value: '8' } });
    expect(cell(DATES[0], '09:00').dataset.selected).toBe('true');
    expect(cell(DATES[0], '08:00').dataset.selected).toBe('false');
  });

  it('publishes visual groups and icon affordances for the time workspace and day headers', async () => {
    render(h(DraftHarness));

    await waitFor(() => expect(cell(DATES[0], '09:00')).toBeTruthy());

    expect(document.querySelector('[data-visual-group="time-selection"]')).toBeTruthy();
    const dayHeaders = document.querySelectorAll('[data-visual-group="day-header"]');
    expect(dayHeaders).toHaveLength(DATES.length);
    expect(dayHeaders[0].querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('drops a removed copy destination instead of resurrecting its times', () => {
    const view = render(h(DraftHarness));
    fireEvent.click(cell(DATES[0], '09:00'));
    fireEvent.click(screen.getByRole('button', { name: /Copy times to.*October 1/i }));
    fireEvent.click(screen.getByRole('checkbox'));
    view.rerender(h(DraftHarness, { dates: [DATES[0]] }));
    expect((screen.getByRole('button', { name: 'Apply copy' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(h(DraftHarness, { dates: DATES }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(cell(DATES[1], '09:00').dataset.selected).toBe('false');
  });
  it('renders empty 30-minute cells with a bounded single-day grid', async () => {
    render(h(DraftHarness));

    await waitFor(() => expect(document.querySelectorAll('[data-proposal-grid] [data-slot-key]')).toHaveLength(32));
    const grid = document.querySelector<HTMLElement>('[data-proposal-grid]');
    expect(grid?.dataset.singleDayLock).toBe('true');
    expect(grid?.dataset.selectedDates).toBe(DATES.join(','));
    expect(cell(DATES[0], '09:00').dataset.selected).toBe('false');
    expect(cell(DATES[1], '16:30').dataset.selected).toBe('false');
    expect(grid?.querySelector('.day-times-scroll')).toBeTruthy();
  });

  it('toggles a slot by click or keyboard without touching another date', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '09:00')).toBeTruthy());

    fireEvent.click(cell(DATES[0], '09:00'));
    expect(cell(DATES[0], '09:00').dataset.selected).toBe('true');
    expect(cell(DATES[1], '09:00').dataset.selected).toBe('false');

    fireEvent.keyDown(cell(DATES[0], '09:00'), { key: 'Enter' });
    expect(cell(DATES[0], '09:00').dataset.selected).toBe('false');
    fireEvent.keyDown(cell(DATES[0], '09:00'), { key: ' ' });
    expect(cell(DATES[0], '09:00').dataset.selected).toBe('true');
  });

  it('drags only within the origin day and stops cleanly on pointer cancel', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '10:00')).toBeTruthy());

    const origin = cell(DATES[0], '10:00');
    const destination = cell(DATES[1], '11:00');
    fireEvent.pointerDown(origin, { pointerId: 4, pointerType: 'mouse', button: 0 });
    const out = new MouseEvent('pointerout', { bubbles: true, relatedTarget: destination });
    Object.defineProperty(out, 'pointerType', { value: 'mouse' });
    fireEvent(origin, out);
    fireEvent.pointerCancel(window, { pointerId: 4, pointerType: 'mouse', button: 0 });

    expect(cell(DATES[0], '10:00').dataset.selected).toBe('true');
    expect(cell(DATES[0], '10:30').dataset.selected).toBe('true');
    expect(cell(DATES[0], '11:00').dataset.selected).toBe('true');
    expect(cell(DATES[1], '10:00').dataset.selected).toBe('false');
    expect(cell(DATES[1], '11:00').dataset.selected).toBe('false');

    fireEvent.click(cell(DATES[1], '11:00'));
    expect(cell(DATES[1], '11:00').dataset.selected).toBe('true');
  });

  it('does not double-toggle after a delayed native click following pointerup', async () => {
    vi.useFakeTimers();
    render(h(DraftHarness));
    await act(async () => {
      await Promise.resolve();
    });

    const origin = cell(DATES[0], '10:00');
    fireEvent.pointerDown(origin, { pointerId: 5, pointerType: 'mouse', button: 0 });
    // A long press must not let a pointer-down timer clear the click guard.
    vi.advanceTimersByTime(1500);
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'mouse', button: 0 });
    vi.advanceTimersByTime(1500);
    fireEvent.click(origin, { detail: 1 });

    expect(origin.dataset.selected).toBe('true');
  });

  it('supports touch and pen drags while locking the stroke to one day', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '10:00')).toBeTruthy());

    const table = document.querySelector<HTMLTableElement>('.day-times-table');
    const origin = cell(DATES[0], '10:00');
    const sameDay = cell(DATES[0], '11:00');
    const otherDay = cell(DATES[1], '11:00');
    expect(table).toBeTruthy();
    expect(origin.style.touchAction).toBe('none');
    expect(document.querySelector('.day-times-scroll')).toBeTruthy();
    expect(screen.getByText(/swipe the time column to scroll/i)).toBeTruthy();

    const originalElementFromPoint = document.elementFromPoint;
    const elementFromPoint = vi.fn<(x: number, y: number) => Element | null>();
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });

    try {
      fireEvent.pointerDown(origin, {
        pointerId: 11,
        pointerType: 'touch',
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      elementFromPoint.mockReturnValue(sameDay);
      fireEvent.pointerMove(table!, {
        pointerId: 11,
        pointerType: 'touch',
        clientX: 10,
        clientY: 120,
      });
      expect(sameDay.dataset.selected).toBe('true');

      // A touch/pen path may cross a neighbouring column; it must not paint it.
      elementFromPoint.mockReturnValue(otherDay);
      fireEvent.pointerMove(table!, {
        pointerId: 11,
        pointerType: 'touch',
        clientX: 240,
        clientY: 120,
      });
      expect(otherDay.dataset.selected).toBe('false');
      fireEvent.pointerCancel(window, { pointerId: 11, pointerType: 'touch' });

      fireEvent.pointerDown(otherDay, {
        pointerId: 12,
        pointerType: 'pen',
        button: 0,
        clientX: 240,
        clientY: 120,
      });
      expect(otherDay.dataset.selected).toBe('true');
      fireEvent.pointerCancel(window, { pointerId: 12, pointerType: 'pen' });
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  it('shows contiguous selected ranges and keeps gaps explicit', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '09:00')).toBeTruthy());

    fireEvent.click(cell(DATES[0], '09:00'));
    fireEvent.click(cell(DATES[0], '09:30'));
    fireEvent.click(cell(DATES[0], '10:30'));

    const day = document.querySelector<HTMLElement>(`[data-day-times-date="${DATES[0]}"]`);
    expect(day?.dataset.selectedRanges).toBe('09:00-10:00,10:30-11:00');
    expect(cell(DATES[0], '09:00').dataset.rangeStart).toBe('09:00');
    expect(cell(DATES[0], '09:30').dataset.rangeEnd).toBe('10:00');
    expect(cell(DATES[0], '10:30').dataset.rangeStart).toBe('10:30');
    expect(cell(DATES[0], '10:30').dataset.rangeEnd).toBe('11:00');
  });

  it('keeps start and end labels separated for a single selected slot', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '13:00')).toBeTruthy());

    fireEvent.click(cell(DATES[0], '13:00'));

    const selectedSlot = cell(DATES[0], '13:00');
    const boundaryGroup = selectedSlot.querySelector<HTMLElement>('.day-times-boundary-group');
    expect(boundaryGroup).not.toBeNull();
    expect(boundaryGroup?.dataset.boundaryGroup).toBe('single-slot');
    expect(boundaryGroup?.querySelectorAll('.day-times-boundary')).toHaveLength(2);
    expect(boundaryGroup?.querySelector('.day-times-boundary--start')?.textContent).toBe('1:00 PM');
    expect(boundaryGroup?.querySelector('.day-times-boundary--end')?.textContent).toBe('1:30 PM');
    expect(selectedSlot.getAttribute('aria-pressed')).toBe('true');
    expect(selectedSlot.getAttribute('aria-label')).toContain('proposed');
  });

  it('copies exact source times only after destination selection and explicit apply', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '09:00')).toBeTruthy());
    fireEvent.click(cell(DATES[0], '09:00'));
    fireEvent.click(cell(DATES[0], '09:30'));
    fireEvent.click(screen.getByRole('button', { name: /Copy times to.*October 1/i }));

    expect(screen.getByText(/replaces selected destination times/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Apply copy/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(document.querySelector<HTMLInputElement>('#day-times-copy-dialog-2026-10-02')!);
    fireEvent.click(screen.getByRole('button', { name: /Apply copy/i }));

    expect(cell(DATES[0], '09:00').dataset.selected).toBe('true');
    expect(cell(DATES[0], '09:30').dataset.selected).toBe('true');
    expect(cell(DATES[1], '09:00').dataset.selected).toBe('true');
    expect(cell(DATES[1], '09:30').dataset.selected).toBe('true');
    expect(cell(DATES[1], '10:00').dataset.selected).toBe('false');
  });

  it('expands the visible range without silently selecting new rows', async () => {
    render(h(DraftHarness));
    await waitFor(() => expect(cell(DATES[0], '09:00')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Show earlier from'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Show later until'), { target: { value: '18' } });

    expect(cell(DATES[0], '08:00').dataset.selected).toBe('false');
    expect(cell(DATES[0], '17:30').dataset.selected).toBe('false');
    expect(document.querySelector<HTMLElement>('[data-proposal-grid]')?.dataset.startHour).toBe('8');
    expect(document.querySelector<HTMLElement>('[data-proposal-grid]')?.dataset.endHour).toBe('18');
  });

  it('publishes invalid state through alert and described-by contracts', () => {
    function ErrorHarness() {
      const draft = useProposalDraft(9, 17, true);
      return <DayTimesEditor draft={draft} idPrefix="error-editor" error="Choose at least one time." />;
    }

    render(h(ErrorHarness));
    expect(screen.getByRole('alert').textContent).toContain('Choose at least one time.');
    const editor = document.querySelector<HTMLElement>('[data-day-times-editor]');
    expect(editor?.getAttribute('aria-describedby')).toContain('error-editor-hours-error');
  });
});
