import { useMemo, useState } from 'react';
import { generateTimeSlots, isValidHourWindow } from '../utils/consensus';

// ─── Proposed dates and times being drafted ───
// Shared by "New Poll" and "Add Dates": selected dates, the hour range the grid
// shows, and the exact slots proposed per date.

export const DRAFT_SLOT_INTERVAL = 30;

export function rangeTimes(startHour: number, endHour: number, interval = DRAFT_SLOT_INTERVAL): string[] {
  return isValidHourWindow(startHour, endHour) ? generateTimeSlots(startHour, endHour, interval) : [];
}

export interface ProposalDraft {
  selectedDates: string[];
  startHour: number;
  endHour: number;
  proposed: Record<string, string[]>;
  /** Grid rows for the current range. */
  gridTimes: string[];
  setProposed: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  /** Start over with no dates and this range. */
  reset: (startHour: number, endHour: number) => void;
  toggleDate: (date: string) => void;
  setDates: (dates: string[]) => void;
  changeRange: (startHour: number, endHour: number) => void;
  /** First of these dates that proposes nothing, if any. */
  findEmptyDay: (dates: string[]) => string | undefined;
  /** Exact slots for these dates, and whether every one is the untouched full range. */
  slotsFor: (dates: string[]) => { proposedSlots: Record<string, string[]>; isFullRange: boolean };
}

export function useProposalDraft(initialStart: number, initialEnd: number): ProposalDraft {
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [startHour, setStartHour] = useState(initialStart);
  const [endHour, setEndHour] = useState(initialEnd);
  // date -> proposed slot starts, edited on the drag grid inside the hour range
  const [proposed, setProposed] = useState<Record<string, string[]>>({});

  const gridTimes = useMemo(() => rangeTimes(startHour, endHour), [startHour, endHour]);

  // A newly selected date proposes the whole hour range; the organizer trims it.
  // Proposals are only added or dropped per date, so each toggle can update
  // them independently and quick successive clicks never overwrite each other.
  const setDates = (dates: string[]) => {
    setSelectedDates(dates);
    setProposed((prev) => Object.fromEntries(dates.map((d) => [d, prev[d] ?? rangeTimes(startHour, endHour)])));
  };

  const toggleDate = (date: string) => {
    setSelectedDates((prev) => (prev.includes(date) ? prev.filter((d) => d !== date) : [...prev, date].sort()));
    setProposed((prev) => {
      const next = { ...prev };
      if (next[date]) delete next[date];
      else next[date] = rangeTimes(startHour, endHour);
      return next;
    });
  };

  // Changing the range keeps each day's picks inside it and proposes rows that
  // just became visible, so widening the range extends every day.
  const changeRange = (nextStart: number, nextEnd: number) => {
    setStartHour(nextStart);
    setEndHour(nextEnd);
    // An inverted range is reported on submit; keep the picks until it is fixed.
    if (!isValidHourWindow(nextStart, nextEnd)) return;
    const before = new Set(rangeTimes(startHour, endHour));
    const after = rangeTimes(nextStart, nextEnd);
    const added = after.filter((t) => !before.has(t));
    setProposed((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([d, times]) => [
          d,
          [...new Set([...times.filter((t) => after.includes(t)), ...added])].sort(),
        ])
      )
    );
  };

  const reset = (nextStart: number, nextEnd: number) => {
    setSelectedDates([]);
    setProposed({});
    setStartHour(nextStart);
    setEndHour(nextEnd);
  };

  const findEmptyDay = (dates: string[]) => dates.find((d) => !(proposed[d] ?? []).length);

  const slotsFor = (dates: string[]) => ({
    proposedSlots: Object.fromEntries(dates.map((d) => [d, proposed[d] ?? []])),
    isFullRange: dates.every((d) => (proposed[d] ?? []).length === gridTimes.length),
  });

  return {
    selectedDates,
    startHour,
    endHour,
    proposed,
    gridTimes,
    setProposed,
    reset,
    toggleDate,
    setDates,
    changeRange,
    findEmptyDay,
    slotsFor,
  };
}
