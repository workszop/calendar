import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateHeading, toDateStr } from '../utils/calendar';
import './month-calendar.css';

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
  /** Dates already taken (e.g. already in the poll): shown marked, not selectable. */
  lockedDates?: string[];
  /** Shows up to three months when the calendar container has enough room. */
  responsive?: boolean;
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
const MOBILE_BREAKPOINT = 768;
const COMPACT_MONTH_WIDTH = 300;
const COMPACT_MONTH_GAP = 16;
const MAX_VISIBLE_MONTHS = 3;
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

// ─── Helpers ───
function visibleMonthCount(width: number, mobile: boolean): number {
  return mobile ? 1 : Math.max(1, Math.min(MAX_VISIBLE_MONTHS,
    Math.floor((width + COMPACT_MONTH_GAP) / (COMPACT_MONTH_WIDTH + COMPACT_MONTH_GAP))));
}

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

function monthKey(month: Date): string {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: Date): string {
  return month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function monthEnd(month: Date): string {
  return toDateStr(new Date(month.getFullYear(), month.getMonth() + 1, 0));
}

function isPositiveWidth(width: number | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

function viewportIsMobile(media: MediaQueryList | null): boolean {
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  return viewportWidth <= MOBILE_BREAKPOINT || Boolean(media?.matches);
}

// ─── Month view ───
interface MonthViewProps {
  month: Date;
  selectedDates: Set<string>;
  lockedDates: Set<string>;
  minDate: string;
  activeDate: string;
  invalid: boolean;
  describedBy?: string;
  labelId: string;
  gridId?: string;
  showHeading: boolean;
  onFocusDate: (date: string) => void;
  onToggle: (date: string) => void;
}

function MonthView({
  month,
  selectedDates,
  lockedDates,
  minDate,
  activeDate,
  invalid,
  describedBy,
  labelId,
  gridId,
  showHeading,
  onFocusDate,
  onToggle,
}: MonthViewProps) {
  const year = month.getFullYear();
  const monthNumber = month.getMonth();
  const weeks = buildWeeks(year, monthNumber);

  return (
    <section className="month-calendar__month" data-month={monthKey(month)}>
      {showHeading && (
        <h3 id={labelId} className="month-calendar__month-title" aria-live="polite">
          {monthLabel(month)}
        </h3>
      )}
      <div
        id={gridId}
        role="grid"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="month-calendar__grid"
      >
        <div role="row" className="month-calendar__grid-row grid grid-cols-7 gap-1">
          {WEEKDAY_LABELS.map((weekday, index) => (
            <div
              key={weekday}
              role="columnheader"
              aria-label={WEEKDAY_LONG_LABELS[index]}
              className="month-calendar__weekday text-center text-[10px] uppercase tracking-wider font-mono text-stone-500 py-1"
            >
              <span aria-hidden="true">{weekday}</span>
            </div>
          ))}
        </div>

        {weeks.map((week, weekIndex) => (
          <div
            key={`week-${monthKey(month)}-${weekIndex}`}
            role="row"
            className="month-calendar__grid-row grid grid-cols-7 gap-1"
          >
            {week.map((cell, cellIndex) => {
              if (!cell) {
                return (
                  <div
                    key={`pad-${monthKey(month)}-${weekIndex}-${cellIndex}`}
                    role="gridcell"
                    className="month-calendar__cell-pad h-9"
                  />
                );
              }

              const dateStr = toDateStr(cell);
              const isSelected = selectedDates.has(dateStr);
              const isPast = dateStr < minDate;
              const isToday = dateStr === minDate;
              // A past day that is still selected stays clickable so it can be
              // removed. Disabled days keep focus (aria-disabled, not disabled)
              // so arrow keys never fall into a hole.
              const isLocked = lockedDates.has(dateStr);
              const isDisabled = isLocked || (isPast && !isSelected);

              return (
                <div key={dateStr} role="gridcell" aria-selected={isSelected}>
                  <button
                    type="button"
                    id={`toggle-date-${dateStr}`}
                    data-date={dateStr}
                    tabIndex={dateStr === activeDate ? 0 : -1}
                    aria-disabled={isDisabled || undefined}
                    aria-pressed={isSelected}
                    aria-label={`${formatDateHeading(dateStr).full}${isLocked ? ' (already in poll)' : ''}`}
                    data-locked={isLocked || undefined}
                    onFocus={() => onFocusDate(dateStr)}
                    onClick={() => {
                      if (isDisabled) return;
                      onToggle(dateStr);
                    }}
                    className={`month-calendar__day w-full h-9 rounded-full text-xs font-semibold transition-colors ${
                      isSelected
                        ? 'bg-yellow-500 text-yellow-950'
                        : isLocked
                          ? 'bg-stone-200 text-stone-500 line-through cursor-not-allowed'
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
    </section>
  );
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
  lockedDates = [],
  responsive = false,
}) => {
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT
  );

  // Responsive mode measures the stable parent/container, not the month grid.
  // The grid is capped at three compact columns, so measuring it would make the
  // layout shrink itself and incorrectly settle on one month.
  useLayoutEffect(() => {
    if (!responsive) {
      setContainerWidth(null);
      setIsMobileViewport(false);
      return;
    }

    const calendar = calendarRef.current;
    if (!calendar) return;

    const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_MEDIA_QUERY)
      : null;
    const parent = calendar.parentElement;

    const measure = () => {
      const parentRectWidth = parent?.getBoundingClientRect().width;
      const parentClientWidth = parent?.clientWidth;
      const calendarRectWidth = calendar.getBoundingClientRect().width;
      const calendarClientWidth = calendar.clientWidth;
      // Prefer this component's own full-width box. Its width is capped by CSS
      // independently of the month grid, so it is the usable width and cannot
      // be inflated by a padded parent panel.
      const width = [calendarRectWidth, calendarClientWidth, parentRectWidth, parentClientWidth].find(
        isPositiveWidth
      ) ?? 0;
      const mobile = viewportIsMobile(media);
      const nextCount = visibleMonthCount(width, mobile);
      const hiddenMonths = Array.from(calendar.querySelectorAll('[data-month]')).slice(nextCount);
      if (hiddenMonths.some(month => month.contains(document.activeElement))) {
        shouldFocus.current = true;
      }
      setContainerWidth((previous) => (previous === width ? previous : width));
      setIsMobileViewport((previous) => (previous === mobile ? previous : mobile));
    };

    measure();

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const observed = new Set<Element>();
    if (parent) observed.add(parent);
    observed.add(calendar);
    observed.forEach((element) => observer?.observe(element));

    window.addEventListener('resize', measure);
    if (media) {
      if (typeof media.addEventListener === 'function') media.addEventListener('change', measure);
      else if (typeof media.addListener === 'function') media.addListener(measure);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      if (media) {
        if (typeof media.removeEventListener === 'function') media.removeEventListener('change', measure);
        else if (typeof media.removeListener === 'function') media.removeListener(measure);
      }
    };
  }, [responsive]);

  const visibleMonths = responsive ? visibleMonthCount(containerWidth ?? 0, isMobileViewport) : 1;
  const calendarMode = responsive ? 'responsive' : 'single';
  const isLegacy = !responsive;

  const months = useMemo(
    () => Array.from({ length: visibleMonths }, (_, offset) => new Date(viewMonth.getFullYear(), viewMonth.getMonth() + offset, 1)),
    [viewMonth, visibleMonths]
  );
  const firstMonthStart = toDateStr(months[0]);
  const lastMonthEnd = monthEnd(months[months.length - 1]);
  const selectedDates = useMemo(() => new Set(selected), [selected]);
  const lockedDatesSet = useMemo(() => new Set(lockedDates), [lockedDates]);

  // The single tab stop. Keyboard navigation moves it; the DOM only takes
  // focus once the user has actually used the keyboard, so mounting steals
  // nothing.
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const shouldFocus = useRef(false);

  const activeDate = useMemo(() => {
    if (focusedDate && focusedDate >= firstMonthStart && focusedDate <= lastMonthEnd) return focusedDate;
    const firstSelected = selected.find((date) => date >= firstMonthStart && date <= lastMonthEnd);
    if (firstSelected) return firstSelected;
    if (minDate >= firstMonthStart && minDate <= lastMonthEnd) return minDate;
    return firstMonthStart;
  }, [focusedDate, firstMonthStart, lastMonthEnd, minDate, selected]);

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${activeDate}"]`)
      ?.focus();
  }, [activeDate]);

  const shiftMonth = useCallback(
    (delta: number) => onViewMonthChange(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1)),
    [onViewMonthChange, viewMonth]
  );

  // Moving out of the displayed month window pulls the month along with the
  // focus. Within a multi-month window, focus crosses directly to the adjacent
  // grid without changing the controlled month.
  const moveFocus = useCallback(
    (nextDate: string) => {
      shouldFocus.current = true;
      setFocusedDate(nextDate);
      if (nextDate < firstMonthStart || nextDate > lastMonthEnd) {
        onViewMonthChange(monthOfDateStr(nextDate));
      }
    },
    [firstMonthStart, lastMonthEnd, onViewMonthChange]
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: string | null = null;
    switch (event.key) {
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
    event.preventDefault();
    moveFocus(next);
  };

  const navigation = (
    <div
      className={`month-calendar__navigation ${isLegacy ? 'flex items-center justify-between mb-2' : ''}`}
      role={isLegacy ? undefined : 'navigation'}
      aria-label={isLegacy ? undefined : 'Calendar navigation'}
    >
      <button
        type="button"
        id="calendar-prev-month"
        aria-label="Previous month"
        onClick={() => shiftMonth(-1)}
        className="month-calendar__nav-button p-1.5 rounded-full text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      {isLegacy && (
        <span id="calendar-month-label" aria-live="polite" className="text-sm font-bold text-stone-900">
          {monthLabel(months[0])}
        </span>
      )}
      <button
        type="button"
        id="calendar-next-month"
        aria-label="Next month"
        onClick={() => shiftMonth(1)}
        className="month-calendar__nav-button p-1.5 rounded-full text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );

  const renderMonth = (month: Date) => {
    const key = monthKey(month);
    return (
      <MonthView
        key={key}
        month={month}
        selectedDates={selectedDates}
        lockedDates={lockedDatesSet}
        minDate={minDate}
        activeDate={activeDate}
        invalid={invalid}
        describedBy={isLegacy ? undefined : describedBy}
        labelId={isLegacy ? 'calendar-month-label' : `calendar-month-label-${key}`}
        gridId={isLegacy ? undefined : `calendar-grid-${key}`}
        showHeading={!isLegacy}
        onFocusDate={setFocusedDate}
        onToggle={onToggle}
      />
    );
  };

  return (
    <div
      ref={calendarRef}
      role="group"
      aria-label="Proposed dates"
      aria-describedby={describedBy}
      data-calendar-mode={calendarMode}
      data-visible-months={visibleMonths}
      className={`month-calendar ${responsive ? 'month-calendar--responsive' : 'month-calendar--legacy'}`}
    >
      <div
        className={`month-calendar__frame ${isLegacy ? `rounded-xl border p-3 ${invalid ? 'border-red-400' : 'border-stone-200'}` : invalid ? 'month-calendar__frame--invalid' : ''}`}
      >
        {navigation}
        {isLegacy ? (
          <div ref={gridRef} onKeyDown={handleKeyDown}>
            {renderMonth(months[0])}
          </div>
        ) : (
          <div
            ref={gridRef}
            onKeyDown={handleKeyDown}
            className="month-calendar__months"
          >
            {months.map(renderMonth)}
          </div>
        )}
      </div>
    </div>
  );
};
