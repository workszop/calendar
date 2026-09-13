import React, { useMemo, useRef } from 'react';
import { Check } from 'lucide-react';
import { formatDateHeading, formatTimeSlot, addMinutesToTime } from '../utils/calendar';
import { slotKey } from '../utils/consensus';
import { useGridStroke } from '../hooks/useGridStroke';
import { SlotTable } from './SlotTable';

// ─── Types ───
export interface ProposalGridProps {
  /** Candidate dates as YYYY-MM-DD, in display order. */
  dates: string[];
  /** Every row the organizer may propose ("HH:mm" slot starts). */
  times: string[];
  /** Minutes per row. */
  slotInterval: number;
  /** date -> proposed slot starts. */
  proposed: Record<string, string[]>;
  /** Receives an updater, so updates between renders never drop one. */
  onChange: (update: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  invalid?: boolean;
  describedBy?: string;
}

// ─── Constants ───
const CELL_ON_CLASS = 'bg-yellow-500 border-yellow-600 text-yellow-950';
const CELL_OFF_CLASS = 'bg-white border-stone-200 text-stone-400 hover:bg-stone-100';

// ─── Component ───
/**
 * Organizer's drag grid: which times on which dates are proposed. Dragging from
 * an unselected cell adds, from a selected cell removes, like a checkbox sweep.
 */
export const ProposalGrid: React.FC<ProposalGridProps> = ({
  dates,
  times,
  slotInterval,
  proposed,
  onChange,
  invalid = false,
  describedBy,
}) => {
  // ─── Derived ───
  const selected = useMemo(
    () => new Set(dates.flatMap((date) => (proposed[date] ?? []).map((time) => slotKey(date, time)))),
    [dates, proposed]
  );
  const dateHeadings = useMemo(() => new Map(dates.map((d) => [d, formatDateHeading(d)])), [dates]);
  const timeSet = useMemo(() => new Set(times), [times]);

  // ─── Helpers ───
  // A proposal with a set of cells switched on or off; always sorted arrays.
  const withKeys = (base: Record<string, string[]>, keys: string[], on: boolean) => {
    const next: Record<string, Set<string>> = Object.fromEntries(
      dates.map((date) => [date, new Set(base[date] ?? [])])
    );
    keys.forEach((key) => {
      const date = key.slice(0, key.indexOf('T'));
      const time = key.slice(key.indexOf('T') + 1);
      if (!next[date] || !timeSet.has(time)) return;
      if (on) next[date].add(time);
      else next[date].delete(time);
    });
    return Object.fromEntries(Object.entries(next).map(([date, set]) => [date, [...set].sort()]));
  };

  const applyKeys = (keys: string[], on: boolean) => onChange((prev) => withKeys(prev, keys, on));

  // ─── Stroke ───
  // Add or remove is decided by the origin cell; the rectangle is drawn over
  // the proposal as it was when the stroke began.
  const strokeOnRef = useRef(true);
  const strokeBaseRef = useRef<Record<string, string[]>>({});
  const stroke = useGridStroke({
    dates,
    times,
    hasCell: (key) => {
      const date = key.slice(0, key.indexOf('T'));
      return dates.includes(date) && timeSet.has(key.slice(key.indexOf('T') + 1));
    },
    onBegin: (key) => {
      strokeOnRef.current = !selected.has(key);
      strokeBaseRef.current = proposed;
    },
    onPaint: (keys) => onChange(() => withKeys(strokeBaseRef.current, keys, strokeOnRef.current)),
    resetKey: `${dates.join()}|${times.join()}`,
  });

  const toggleDay = (date: string) => {
    const allOn = times.every((time) => selected.has(slotKey(date, time)));
    applyKeys(times.map((time) => slotKey(date, time)), !allOn);
  };

  // ─── Render ───
  const renderHeader = (date: string) => {
    const heading = dateHeadings.get(date);
    return (
      <button
        type="button"
        onClick={() => toggleDay(date)}
        aria-label={`Toggle all proposed times on ${heading?.full}`}
        className="w-full py-2 px-2 hover:bg-stone-100 transition-colors"
      >
        <div className="text-[11px] font-semibold uppercase tracking-wider font-mono text-stone-500">
          {heading?.weekday}
        </div>
        <div className="text-xs font-bold text-stone-900">{heading?.dayMonth}</div>
        <span className="block text-[10px] font-mono uppercase tracking-wider text-stone-500">
          {(proposed[date] ?? []).length ? `${(proposed[date] ?? []).length} slots` : 'none'}
        </span>
      </button>
    );
  };

  const renderCell = (date: string, time: string) => {
    const key = slotKey(date, time);
    const on = selected.has(key);
    const heading = dateHeadings.get(date);
    const label = `${heading?.weekday} ${heading?.dayMonth} ${formatTimeSlot(time)} – ${formatTimeSlot(
      addMinutesToTime(time, slotInterval)
    )}: ${on ? 'proposed' : 'not proposed'}`;
    return (
      <button
        type="button"
        data-slot-key={key}
        data-selected={on ? 'true' : 'false'}
        aria-pressed={on}
        aria-label={label}
        title={label}
        style={{ touchAction: 'pan-y' }}
        {...stroke.cellProps(key)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          applyKeys([key], !on);
        }}
        className={`w-full h-7 rounded-md border flex items-center justify-center transition-colors cursor-pointer ${
          on ? CELL_ON_CLASS : CELL_OFF_CLASS
        }`}
      >
        {on && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
      </button>
    );
  };

  if (dates.length === 0) {
    return (
      <p className="text-xs text-stone-500 rounded-xl border border-dashed border-stone-300 px-3 py-4 text-center">
        Select dates above to choose the proposed times.
      </p>
    );
  }

  return (
    <div
      className={`rounded-xl border overflow-hidden select-none ${invalid ? 'border-red-400' : 'border-stone-200'}`}
      aria-describedby={describedBy}
      data-proposal-grid
    >
      <SlotTable
        dates={dates}
        timeSlots={times}
        isProposed={() => true}
        dateHeadings={dateHeadings}
        renderHeader={renderHeader}
        renderCell={renderCell}
        cellHeightClass="h-7"
        tableProps={{ ...stroke.tableProps, 'aria-label': 'Proposed times' } as React.HTMLAttributes<HTMLTableElement>}
      />
    </div>
  );
};
