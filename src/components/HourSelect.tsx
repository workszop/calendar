import React from 'react';
import { formatHour } from '../utils/calendar';

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
