import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, Copy } from 'lucide-react';
import type { ProposalDraft } from '../hooks/useProposalDraft';
import { DRAFT_SLOT_INTERVAL } from '../hooks/useProposalDraft';
import { addMinutesToTime, formatDateHeading, formatHour, formatTimeSlot } from '../utils/calendar';
import { slotKey } from '../utils/consensus';
import { useGridStroke } from '../hooks/useGridStroke';
import { Modal } from './Modal';
import './day-times-editor.css';

// ─── Types ───
export interface DayTimesEditorProps {
  draft: ProposalDraft;
  /** Unique prefix for element ids, so two editors never collide. */
  idPrefix: string;
  error?: string;
  /** Called on any edit, e.g. to clear the error. */
  onEdit?: () => void;
  disabled?: boolean;
}

interface SelectedRange {
  startTime: string;
  endTime: string;
  slotTimes: string[];
}

interface CopyDialogState {
  sourceDate: string;
  destinationDates: string[];
}

// ─── Constants ───
const MIN_HOUR = 0;
const MAX_HOUR = 24;
const HOUR_STEP = DRAFT_SLOT_INTERVAL / 60;

// ─── Helpers ───
function splitSlotKey(key: string): [string, string] {
  const separator = key.indexOf('T');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function hourOptions(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + Number.EPSILON; value += step) {
    values.push(Number(value.toFixed(4)));
  }
  return values;
}

function rangesForDay(times: string[], proposed: string[]): SelectedRange[] {
  const proposedSet = new Set(proposed);
  const ranges: SelectedRange[] = [];
  let current: string[] = [];

  const flush = () => {
    if (!current.length) return;
    ranges.push({
      startTime: current[0],
      endTime: addMinutesToTime(current[current.length - 1], DRAFT_SLOT_INTERVAL),
      slotTimes: current,
    });
    current = [];
  };

  times.forEach((time) => {
    if (proposedSet.has(time)) current.push(time);
    else flush();
  });
  flush();
  return ranges;
}

function rangeText(range: SelectedRange): string {
  return `${range.startTime}-${range.endTime}`;
}

function displayRangeText(range: SelectedRange): string {
  return `${formatTimeSlot(range.startTime)} – ${formatTimeSlot(range.endTime)}`;
}

// ─── Component ───
/**
 * Compact per-day proposal editor. Every cell is one 30-minute slot. A stroke
 * may sweep vertically, but the origin date is deliberately locked so a
 * diagonal gesture can never edit another day by accident.
 */
export const DayTimesEditor: React.FC<DayTimesEditorProps> = ({
  draft,
  idPrefix,
  error,
  onEdit,
  disabled = false,
}) => {
  // ─── State ───
  const [copyDialog, setCopyDialog] = useState<CopyDialogState | null>(null);

  // ─── Refs ───
  const strokeOnRef = useRef(true);
  const strokeBaseRef = useRef<Record<string, string[]>>({});
  const strokeDateRef = useRef<string | null>(null);
  const copyFirstDestinationRef = useRef<HTMLInputElement | null>(null);
  // A native pointer gesture also dispatches click after pointerup. The
  // stroke already changed the slot, so suppress that follow-up click. The
  // detail check keeps fireEvent.click useful in DOM tests and for scripted
  // keyboard activation.
  const suppressClickRef = useRef<'pointer' | 'keyboard' | null>(null);
  const suppressClickKeyRef = useRef<string | null>(null);

  // ─── Derived ───
  const selectedDates = draft.selectedDates;
  const times = draft.gridTimes;
  const dateHeadings = useMemo(
    () => new Map(selectedDates.map((date) => [date, formatDateHeading(date)])),
    [selectedDates]
  );
  const selectedSets = useMemo(
    () =>
      new Map(
        selectedDates.map((date) => [date, new Set(draft.proposed[date] ?? [])])
      ),
    [draft.proposed, selectedDates]
  );
  const rangesByDate = useMemo(
    () =>
      new Map(
        selectedDates.map((date) => [date, rangesForDay(times, draft.proposed[date] ?? [])])
      ),
    [draft.proposed, selectedDates, times]
  );
  const startOptions = useMemo(
    () => hourOptions(MIN_HOUR, Math.min(MAX_HOUR, draft.startHour), HOUR_STEP),
    [draft.startHour]
  );
  const endOptions = useMemo(
    () => hourOptions(Math.max(MIN_HOUR, draft.endHour), MAX_HOUR, HOUR_STEP),
    [draft.endHour]
  );
  const proposedRanges = useMemo(
    () =>
      Object.fromEntries(
        selectedDates.map((date) => [
          date,
          (rangesByDate.get(date) ?? []).map(rangeText),
        ])
      ),
    [rangesByDate, selectedDates]
  );
  const selectedCount = selectedDates.reduce(
    (total, date) => total + (draft.proposed[date] ?? []).filter((time) => times.includes(time)).length,
    0
  );
  const errorId = `${idPrefix}-hours-error`;
  const copyDialogId = `${idPrefix}-copy-dialog`;

  // ─── Effects ───
  useEffect(() => {
    setCopyDialog((previous) => {
      if (!previous) return previous;
      if (!selectedDates.includes(previous.sourceDate)) return null;
      const destinationDates = previous.destinationDates.filter((date) => selectedDates.includes(date));
      return destinationDates.length === previous.destinationDates.length
        ? previous
        : { ...previous, destinationDates };
    });
  }, [selectedDates]);

  // ─── Helpers ───
  const markClickSuppressed = (reason: 'pointer' | 'keyboard') => {
    // Keep this marker until the follow-up click is observed. A short timer
    // here looks convenient, but a slow pointer release would re-introduce a
    // double toggle. A detail=0 scripted click is treated as a fresh action.
    suppressClickRef.current = reason;
  };

  const withSlotKeys = (
    base: Record<string, string[]>,
    keys: string[],
    on: boolean
  ): Record<string, string[]> => {
    const next: Record<string, Set<string>> = Object.fromEntries(
      Object.entries(base).map(([date, values]) => [date, new Set(values)])
    );
    selectedDates.forEach((date) => {
      if (!next[date]) next[date] = new Set<string>();
    });
    keys.forEach((key) => {
      const [date, time] = splitSlotKey(key);
      const day = next[date];
      if (!day || !times.includes(time)) return;
      if (on) day.add(time);
      else day.delete(time);
    });
    return Object.fromEntries(
      Object.entries(next).map(([date, values]) => [date, [...values].sort()])
    );
  };

  const toggleSlot = (date: string, time: string) => {
    if (disabled) return;
    onEdit?.();
    draft.setProposed((previous) => {
      const isOn = (previous[date] ?? []).includes(time);
      return withSlotKeys(previous, [slotKey(date, time)], !isOn);
    });
  };

  const handleRangeChange = (axis: 'start' | 'end', value: string) => {
    if (disabled) return;
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    if (axis === 'start' && next > draft.startHour) return;
    if (axis === 'end' && next < draft.endHour) return;
    if (axis === 'start' && next >= draft.endHour) return;
    if (axis === 'end' && next <= draft.startHour) return;
    onEdit?.();
    draft.changeRange(axis === 'start' ? next : draft.startHour, axis === 'end' ? next : draft.endHour);
  };

  const openCopyDialog = (sourceDate: string) => {
    if (disabled) return;
    // Copy is intentionally a separate confirmation surface; opening it
    // never mutates the draft.
    setCopyDialog({ sourceDate, destinationDates: [] });
  };

  const toggleCopyDestination = (date: string) => {
    setCopyDialog((previous) => {
      if (!previous) return previous;
      const selected = previous.destinationDates.includes(date);
      return {
        ...previous,
        destinationDates: selected
          ? previous.destinationDates.filter((candidate) => candidate !== date)
          : [...previous.destinationDates, date],
      };
    });
  };

  const applyCopy = () => {
    if (!copyDialog || copyDialog.destinationDates.length === 0 || disabled) return;
    if (!selectedDates.includes(copyDialog.sourceDate)) return;
    const destinations = copyDialog.destinationDates.filter((date) => selectedDates.includes(date));
    if (!destinations.length) return;
    draft.setProposed((previous) => {
      const sourceTimes = [...(previous[copyDialog.sourceDate] ?? [])].sort();
      const next = { ...previous };
      destinations.forEach((date) => {
        next[date] = [...sourceTimes];
      });
      return next;
    });
    onEdit?.();
    setCopyDialog(null);
  };

  // ─── Stroke ───
  const stroke = useGridStroke({
    dates: selectedDates,
    times,
    hasCell: (key) => {
      const [date, time] = splitSlotKey(key);
      return selectedDates.includes(date) && times.includes(time);
    },
    disabled,
    onBegin: (key) => {
      const [date, time] = splitSlotKey(key);
      strokeDateRef.current = date;
      strokeOnRef.current = !(draft.proposed[date] ?? []).includes(time);
      strokeBaseRef.current = draft.proposed;
      markClickSuppressed('pointer');
      suppressClickKeyRef.current = key;
      onEdit?.();
    },
    onPaint: (keys) => {
      const originDate = strokeDateRef.current;
      if (!originDate) return;
      // This filter is intentionally separate from hasCell: useGridStroke's
      // rectangle can span columns, but this editor is a single-day stroke.
      const sameDayKeys = keys.filter((key) => splitSlotKey(key)[0] === originDate);
      draft.setProposed(() => withSlotKeys(strokeBaseRef.current, sameDayKeys, strokeOnRef.current));
    },
    onEnd: (_origin, _moved) => {
      // Keep the pointer marker through the native click that follows
      // pointerup. A delayed click must still not toggle the origin twice.
      strokeDateRef.current = null;
    },
    resetKey: `${selectedDates.join(',')}|${times.join(',')}`,
  });

  // ─── Render ───
  const renderRangeControl = (
    axis: 'start' | 'end',
    label: string,
    value: number,
    options: number[]
  ) => (
    <label className="day-times-range-control" htmlFor={`${idPrefix}-${axis}-hour`}>
      <span>{label}</span>
      <select
        id={`${idPrefix}-${axis}-hour`}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        data-range-control={axis}
        disabled={disabled}
        onChange={(event) => handleRangeChange(axis, event.target.value)}
      >
        {options.map((hour) => (
          <option key={hour} value={hour}>
            {formatHour(hour)}
          </option>
        ))}
      </select>
    </label>
  );

  const renderDayHeader = (date: string) => {
    const heading = dateHeadings.get(date);
    const ranges = rangesByDate.get(date) ?? [];
    const selectedForDay = selectedSets.get(date) ?? new Set<string>();
    return (
      <div
        className="day-times-day-header"
        data-visual-group="day-header"
        data-day-times-date={date}
        data-selected={selectedForDay.size ? 'true' : 'false'}
        data-selected-count={selectedForDay.size}
        data-selected-ranges={ranges.map(rangeText).join(',')}
      >
        <div className="day-times-day-copy">
          <CalendarDays className="day-times-day-icon" data-visual-icon="day" aria-hidden="true" />
          <span className="day-times-weekday">{heading?.weekday ?? date}</span>
          <span className="day-times-day-month">{heading?.dayMonth ?? date}</span>
          <span className="day-times-day-count" data-selected-count={selectedForDay.size}>
            {selectedForDay.size ? `${selectedForDay.size} slots` : 'No times'}
          </span>
        </div>
        <button
          type="button"
          className="day-times-copy-button"
          aria-label={`Copy times to… from ${heading?.full ?? date}`}
          data-copy-source-date={date}
          disabled={disabled || selectedDates.length < 2}
          onClick={() => openCopyDialog(date)}
        >
          <Copy aria-hidden="true" />
          <span>Copy times to…</span>
        </button>
        <div className="day-times-range-summary">
          {ranges.length ? ranges.map(displayRangeText).join(', ') : 'No times selected'}
        </div>
      </div>
    );
  };

  const renderCell = (date: string, time: string) => {
    const key = slotKey(date, time);
    const selected = selectedSets.get(date)?.has(time) ?? false;
    const ranges = rangesByDate.get(date) ?? [];
    const range = ranges.find((candidate) => candidate.slotTimes.includes(time));
    const isRangeStart = Boolean(range && range.startTime === time);
    const isRangeEnd = Boolean(range && range.endTime === addMinutesToTime(time, DRAFT_SLOT_INTERVAL));
    const heading = dateHeadings.get(date);
    const endTime = addMinutesToTime(time, DRAFT_SLOT_INTERVAL);
    const label = `${heading?.full ?? date}, ${formatTimeSlot(time)} – ${formatTimeSlot(endTime)}: ${
      selected ? 'proposed' : 'not proposed'
    }`;
    const cellStrokeProps = stroke.cellProps(key);

    return (
      <button
        type="button"
        data-slot-key={key}
        data-selected={selected ? 'true' : 'false'}
        data-date={date}
        data-time={time}
        data-range-start={isRangeStart ? time : undefined}
        data-range-end={isRangeEnd ? endTime : undefined}
        aria-pressed={selected}
        aria-label={label}
        aria-describedby={error ? errorId : undefined}
        title={label}
        disabled={disabled}
        // A slot consumes a touch gesture for painting. The surrounding
        // overflow container remains scrollable from its header/time gutter.
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => {
          if (!disabled && (event.pointerType !== 'mouse' || event.button === 0)) {
            markClickSuppressed('pointer');
          }
          cellStrokeProps.onPointerDown(event);
        }}
        onPointerEnter={cellStrokeProps.onPointerEnter}
        onClick={(event) => {
          const suppression = suppressClickRef.current;
          if (
            (suppression === 'pointer' && (event.detail > 0 || suppressClickKeyRef.current === key)) ||
            (suppression === 'keyboard' &&
              event.detail === 0 &&
              suppressClickKeyRef.current === key)
          ) {
            suppressClickRef.current = null;
            suppressClickKeyRef.current = null;
            return;
          }
          suppressClickRef.current = null;
          suppressClickKeyRef.current = null;
          toggleSlot(date, time);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          markClickSuppressed('keyboard');
          suppressClickKeyRef.current = key;
          toggleSlot(date, time);
        }}
        className={`day-times-cell${selected ? ' day-times-cell--selected' : ''}${
          isRangeStart ? ' day-times-cell--range-start' : ''
        }${isRangeEnd ? ' day-times-cell--range-end' : ''}`}
      >
        {selected ? (
          isRangeStart || isRangeEnd ? (
            <span
              className="day-times-boundary-group"
              data-boundary-group={isRangeStart && isRangeEnd ? 'single-slot' : 'range-edge'}
              aria-hidden="true"
            >
              {isRangeStart && (
                <span className="day-times-boundary day-times-boundary--start" aria-hidden="true">
                  {formatTimeSlot(time)}
                </span>
              )}
              {isRangeEnd && (
                <span className="day-times-boundary day-times-boundary--end" aria-hidden="true">
                  {formatTimeSlot(endTime)}
                </span>
              )}
            </span>
          ) : (
            <Check className="day-times-check" aria-hidden="true" />
          )
        ) : null}
      </button>
    );
  };

  const copySourceHeading = copyDialog ? dateHeadings.get(copyDialog.sourceDate) : undefined;

  return (
    <fieldset
      className="day-times-editor"
      disabled={disabled}
      aria-describedby={error ? errorId : undefined}
      data-day-times-editor
      data-visual-group="time-selection"
      data-disabled={disabled ? 'true' : 'false'}
      data-selected-dates={selectedDates.join(',')}
      data-slot-interval={DRAFT_SLOT_INTERVAL}
      data-start-hour={draft.startHour}
      data-end-hour={draft.endHour}
      data-selected-count={selectedCount}
    >
      <legend className="sr-only">Proposed times</legend>
      <div className="day-times-instructions" id={`${idPrefix}-instructions`}>
        <span>
          Click a 30-minute slot to toggle it. Drag vertically within one day to select a range. Gaps are fine.
        </span>
        <span className="day-times-touch-hint">On touch, drag cells to select; swipe the Time column to scroll.</span>
      </div>
      <div
        className="day-times-grid-wrap"
        data-proposal-grid={selectedDates.length ? '' : undefined}
        data-single-day-lock="true"
        data-slot-interval={DRAFT_SLOT_INTERVAL}
        data-selected-dates={selectedDates.join(',')}
        data-start-hour={draft.startHour}
        data-end-hour={draft.endHour}
        data-selected-state={JSON.stringify(draft.proposed)}
        data-proposed-ranges={JSON.stringify(proposedRanges)}
        aria-describedby={`${idPrefix}-instructions${error ? ` ${errorId}` : ''}`}
      >
        {selectedDates.length === 0 ? (
          <p className="day-times-empty">Select at least one date to choose proposed times.</p>
        ) : (
          <div className="day-times-scroll">
            <table
              className="day-times-table"
              {...stroke.tableProps}
              aria-label="Proposed times by day"
            >
              <thead>
                <tr>
                  <th scope="col" className="day-times-time-heading">
                    Time
                  </th>
                  {selectedDates.map((date) => (
                    <th scope="col" key={date} className="day-times-day-column">
                      {renderDayHeader(date)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {times.map((time) => (
                  <tr key={time}>
                    <th scope="row" className="day-times-time-label">
                      {formatTimeSlot(time)}
                    </th>
                    {selectedDates.map((date) => (
                      <td key={date} className="day-times-slot-cell">
                        {renderCell(date, time)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="day-times-range-controls" data-range-controls="below-table">
        <p className="day-times-legend">Proposed times</p>
        <div className="day-times-range-row">
          {renderRangeControl('start', 'Show earlier from', draft.startHour, startOptions)}
          <span className="day-times-range-separator" aria-hidden="true">
            to
          </span>
          {renderRangeControl('end', 'Show later until', draft.endHour, endOptions)}
        </div>
        <p className="day-times-range-note">
          Expand the window to show more rows. New rows start unselected.
        </p>
      </div>
      <p className="day-times-live" aria-live="polite" data-selection-live>
        {selectedCount} proposed {selectedCount === 1 ? 'slot' : 'slots'} across {selectedDates.length}{' '}
        {selectedDates.length === 1 ? 'day' : 'days'}.
      </p>

      {copyDialog && (
        <Modal
          isOpen
          onClose={() => setCopyDialog(null)}
          title="Copy times to…"
          subtitle={`Choose destination dates for ${copySourceHeading?.full ?? copyDialog.sourceDate}. Applying replaces selected destination times.`}
          panelClassName="day-times-copy-modal"
          initialFocusRef={copyFirstDestinationRef}
        >
          <div id={copyDialogId} className="day-times-copy-dialog">
            <div className="day-times-copy-destinations">
              {selectedDates
                .filter((date) => date !== copyDialog.sourceDate)
                .map((date, index) => {
                  const heading = dateHeadings.get(date);
                  const checked = copyDialog.destinationDates.includes(date);
                  const checkboxId = `${copyDialogId}-${date}`;
                  return (
                    <label
                      key={date}
                      htmlFor={checkboxId}
                      className="day-times-copy-destination"
                      data-copy-destination-date={date}
                    >
                      <input
                        ref={index === 0 ? copyFirstDestinationRef : undefined}
                        id={checkboxId}
                        type="checkbox"
                        data-copy-destination-date={date}
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleCopyDestination(date)}
                      />
                      <span>{heading?.full ?? date}</span>
                    </label>
                  );
                })}
            </div>
            <div className="day-times-copy-actions">
              <button type="button" className="day-times-copy-cancel" onClick={() => setCopyDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="day-times-copy-apply"
                disabled={disabled || copyDialog.destinationDates.length === 0}
                onClick={applyCopy}
              >
                Apply copy
              </button>
            </div>
          </div>
        </Modal>
      )}

      {error && (
        <p id={errorId} role="alert" className="day-times-error">
          {error}
        </p>
      )}
    </fieldset>
  );
};
