import React from 'react';
import type { DayHours } from '../types';
import { formatDateHeading, formatHour } from '../utils/calendar';
import { isValidHourWindow } from '../utils/consensus';

// ─── Constants ───
/** Proposed hours in 30-minute steps, 6:00 through 22:00. */
const HOURS: number[] = Array.from({ length: 33 }, (_, i) => 6 + i * 0.5);

/** One shared set of <option> elements, reused by every hour select. */
const hourOptions = HOURS.map((h) => (
  <option key={h} value={h}>
    {formatHour(h)}
  </option>
));

// ─── Types ───
export interface HourSelectProps {
  id: string;
  value: number;
  onChange: (hour: number) => void;
  ariaLabel?: string;
  /** id of the element describing the current error, if any. */
  describedBy?: string;
  invalid?: boolean;
  className?: string;
}

export interface PerDayHoursProps {
  /** Selected dates as YYYY-MM-DD, in display order. */
  dates: string[];
  /** Window applied to any date without an override. */
  defaultHours: DayHours;
  overrides: Record<string, DayHours>;
  onChange: (date: string, patch: Partial<DayHours>) => void;
  onReset: (date: string) => void;
}

// ─── Components ───
export const HourSelect: React.FC<HourSelectProps> = ({
  id,
  value,
  onChange,
  ariaLabel,
  describedBy,
  invalid = false,
  className = '',
}) => (
  <select
    id={id}
    aria-label={ariaLabel}
    aria-invalid={invalid || undefined}
    aria-describedby={describedBy}
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
    className={`${className} ${invalid ? 'border-red-400' : ''}`}
  >
    {hourOptions}
  </select>
);

export const PerDayHours: React.FC<PerDayHoursProps> = ({
  dates,
  defaultHours,
  overrides,
  onChange,
  onReset,
}) => {
  if (dates.length === 0) return null;

  return (
    <fieldset className="space-y-2">
      <legend className="edu-label">Proposed hours per day</legend>
      <p className="text-xs text-stone-500">
        Participants answer only within these hours. Each day follows the proposed hours above
        unless you adjust it here.
      </p>
      <div className="rounded-xl border border-stone-200 divide-y divide-stone-200">
        {dates.map((dateStr) => {
          const heading = formatDateHeading(dateStr);
          const hours = overrides[dateStr] ?? defaultHours;
          const custom = Boolean(overrides[dateStr]);
          const invalid = !isValidHourWindow(hours.startHour, hours.endHour);
          return (
            <div key={dateStr} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-stone-900 w-28">
                  <span className="font-mono uppercase tracking-wider text-stone-500 mr-1">
                    {heading.weekday}
                  </span>
                  {heading.dayMonth}
                </span>
                <HourSelect
                  id={`day-start-${dateStr}`}
                  ariaLabel={`Start hour on ${heading.full}`}
                  value={hours.startHour}
                  invalid={invalid}
                  onChange={(h) => onChange(dateStr, { startHour: h })}
                  className="edu-input w-auto px-2 py-1 text-xs rounded-lg"
                />
                <span className="text-xs text-stone-400">to</span>
                <HourSelect
                  id={`day-end-${dateStr}`}
                  ariaLabel={`End hour on ${heading.full}`}
                  value={hours.endHour}
                  invalid={invalid}
                  onChange={(h) => onChange(dateStr, { endHour: h })}
                  className="edu-input w-auto px-2 py-1 text-xs rounded-lg"
                />
                {custom ? (
                  <button
                    type="button"
                    onClick={() => onReset(dateStr)}
                    className="ml-auto text-[11px] font-semibold text-stone-500 hover:text-stone-900 underline underline-offset-2 transition-colors"
                  >
                    Use proposed hours
                  </button>
                ) : (
                  <span className="ml-auto text-[11px] text-stone-400">proposed hours</span>
                )}
              </div>
              {invalid && (
                <p role="alert" className="text-xs text-red-700 mt-1">
                  Start hour must be earlier than end hour.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
};
