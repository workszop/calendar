import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateHeading, toDateStr } from '../utils/calendar';

// ─── Types ───
export interface MonthCalendarProps {
  /** Selected dates as YYYY-MM-DD. */
  selected: string[];
  onToggle: (date: string) => void;
  /** Earliest selectable date as YYYY-MM-DD (usually today). */
  minDate: string;
  /** Controlled month: any Date inside the month to display. */
  viewMonth: Date;
  onViewMonthChange: (month: Date) => void;
  /** Marks the whole grid invalid, e.g. when nothing is selected on submit. */
  invalid?: boolean;
  describedBy?: string;
}

// ─── Constants ───
// Locale weekday names anchored to Monday (2024-01-01 was a Monday).
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })
);
const WEEKDAY_LONG_LABELS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' })
);
const WEEKS = 6; // always 6 rows, so the panel height never jumps
const DAYS_IN_WEEK = 7;

// ─── Helpers ───
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Month containing a YYYY-MM-DD string, as a first-of-month Date. */
export function monthOfDateStr(dateStr: string): Date {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

function parseDateStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Six Monday-anchored weeks covering the month; days outside it are null. */
function buildWeeks(year: number, month: number): (Date | null)[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-anchored
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length < WEEKS * DAYS_IN_WEEK) cells.push(null);
  return Array.from({ length: WEEKS }, (_, w) =>
    cells.slice(w * DAYS_IN_WEEK, (w + 1) * DAYS_IN_WEEK)
  );
}

function addDays(dateStr: string, delta: number): string {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
}

/** Same day-of-month in another month, clamped to that month's length. */
function addMonths(dateStr: string, delta: number): string {
  const d = parseDateStr(dateStr);
  const target = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return toDateStr(target);
}

/** Monday of the week containing dateStr. */
function startOfWeek(dateStr: string): string {
  const d = parseDateStr(dateStr);
  return addDays(dateStr, -((d.getDay() + 6) % 7));
}

// ─── Component ───
export const MonthCalendar: React.FC<MonthCalendarProps> = ({
  selected,
  onToggle,
  minDate,
  viewMonth,
  onViewMonthChange,
  invalid = false,
  describedBy,
}) => {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();

  const weeks = useMemo(() => buildWeeks(year, month), [year, month]);
  const monthLabel = useMemo(
    () => new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    [year, month]
  );
  const monthStart = toDateStr(new Date(year, month, 1));
  const monthEnd = toDateStr(new Date(year, month + 1, 0));

  // The single tab stop. Keyboard navigation moves it; the DOM only takes focus
  // once the user has actually used the keyboard, so mounting steals nothing.
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const shouldFocus = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const activeDate = useMemo(() => {
    if (focusedDate && focusedDate >= monthStart && focusedDate <= monthEnd) return focusedDate;
    const firstSelected = selected.find((d) => d >= monthStart && d <= monthEnd);
    if (firstSelected) return firstSelected;
    if (minDate >= monthStart && minDate <= monthEnd) return minDate;
    return monthStart;
  }, [focusedDate, monthStart, monthEnd, selected, minDate]);

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${activeDate}"]`)
      ?.focus();
  }, [activeDate]);

  const shiftMonth = useCallback(
    (delta: number) => onViewMonthChange(new Date(year, month + delta, 1)),
    [onViewMonthChange, year, month]
  );

  // Moving out of the displayed month pulls the month along with the focus.
  const moveFocus = useCallback(
    (nextDate: string) => {
      shouldFocus.current = true;
      setFocusedDate(nextDate);
      if (nextDate < monthStart || nextDate > monthEnd) onViewMonthChange(monthOfDateStr(nextDate));
    },
    [monthStart, monthEnd, onViewMonthChange]
  );

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: string | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(activeDate, -1);
        break;
      case 'ArrowRight':
        next = addDays(activeDate, 1);
        break;
      case 'ArrowUp':
        next = addDays(activeDate, -DAYS_IN_WEEK);
        break;
      case 'ArrowDown':
        next = addDays(activeDate, DAYS_IN_WEEK);
        break;
      case 'Home':
        next = startOfWeek(activeDate);
        break;
      case 'End':
        next = addDays(startOfWeek(activeDate), DAYS_IN_WEEK - 1);
        break;
      case 'PageUp':
        next = addMonths(activeDate, -1);
        break;
      case 'PageDown':
        next = addMonths(activeDate, 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    moveFocus(next);
  };

  return (
    <div role="group" aria-label="Proposed dates" aria-describedby={describedBy}>
      <div className={`rounded-xl border p-3 ${invalid ? 'border-red-400' : 'border-stone-200'}`}>
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            id="calendar-prev-month"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
            className="p-1.5 rounded-full text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span
            id="calendar-month-label"
            aria-live="polite"
            className="text-sm font-bold text-stone-900"
          >
            {monthLabel}
          </span>
          <button
            type="button"
            id="calendar-next-month"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
            className="p-1.5 rounded-full text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div
          ref={gridRef}
          role="grid"
          aria-labelledby="calendar-month-label"
          aria-invalid={invalid || undefined}
          onKeyDown={handleKeyDown}
        >
          <div role="row" className="grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((w, i) => (
              <div
                key={w}
                role="columnheader"
                aria-label={WEEKDAY_LONG_LABELS[i]}
                className="text-center text-[10px] uppercase tracking-wider font-mono text-stone-500 py-1"
              >
                <span aria-hidden="true">{w}</span>
              </div>
            ))}
          </div>

          {weeks.map((week, w) => (
            <div key={`week-${w}`} role="row" className="grid grid-cols-7 gap-1">
              {week.map((cell, i) => {
                if (!cell) {
                  return <div key={`pad-${w}-${i}`} role="gridcell" className="h-9" />;
                }
                const dateStr = toDateStr(cell);
                const isSelected = selected.includes(dateStr);
                const isPast = dateStr < minDate;
                const isToday = dateStr === minDate;
                // A past day that is still selected stays clickable so it can be
                // removed. Disabled days keep focus (aria-disabled, not disabled)
                // so arrow keys never fall into a hole.
                const isDisabled = isPast && !isSelected;
                return (
                  <div key={dateStr} role="gridcell" aria-selected={isSelected}>
                    <button
                      type="button"
                      id={`toggle-date-${dateStr}`}
                      data-date={dateStr}
                      tabIndex={dateStr === activeDate ? 0 : -1}
                      aria-disabled={isDisabled || undefined}
                      aria-pressed={isSelected}
                      aria-label={formatDateHeading(dateStr).full}
                      onFocus={() => setFocusedDate(dateStr)}
                      onClick={() => {
                        if (isDisabled) return;
                        onToggle(dateStr);
                      }}
                      className={`w-full h-9 rounded-full text-xs font-semibold transition-colors ${
                        isSelected
                          ? 'bg-yellow-500 text-yellow-950'
                          : isDisabled
                            ? 'text-stone-300 cursor-not-allowed'
                            : 'text-stone-700 hover:bg-stone-100'
                      } ${isToday && !isSelected ? 'ring-1 ring-stone-300' : ''}`}
                    >
                      {cell.getDate()}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
