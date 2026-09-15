import { useMemo } from 'react';
import type { Poll } from '../types';
import { addMinutesToTime, formatDateHeading, hourToTimeStr } from '../utils/calendar';
import { generateDaySlots, slotKey, timeToMinutes } from '../utils/consensus';
import type { GridBlock, GridInterval } from '../utils/grid';

export interface PollGrid {
  /** Every row's start, "HH:mm" sorted. Rows sit on display-interval boundaries. */
  timeSlots: string[];
  /** date -> set of times proposed on that date. */
  daySlots: Map<string, Set<string>>;
  /**
   * Display cells keyed by date and row, mapped to their unchanged underlying
   * atomic slots. A block's startTime is its first real slot, so a partial block
   * (e.g. 09:30-10:00 in an hourly view) sits on the 09:00 row.
   */
  blocks: Map<string, GridBlock>;
  /** date -> the formatted column heading for that date. */
  dateHeadings: Map<string, ReturnType<typeof formatDateHeading>>;
  /** Was this cell proposed by the organizer? */
  isProposed: (date: string, time: string) => boolean;
}

/**
 * Derives the proposed grid shape once per poll instead of on every render.
 */
export function usePollGrid(poll: Poll, gridInterval?: GridInterval): PollGrid {
  return useMemo(() => {
    const daySlots = new Map<string, Set<string>>(
      poll.dates.map((date) => [date, new Set(generateDaySlots(poll, date))])
    );
    const blocks = new Map<string, GridBlock>();
    const blockMinutes = gridInterval ?? poll.slotInterval;
    // Blocks align to clock boundaries (whole hours in the hourly view), never
    // to a day's first slot, so days starting at 09:00 and 09:30 share rows.
    const boundaryOf = (time: string) => {
      const minutes = timeToMinutes(time);
      return minutes - (minutes % blockMinutes);
    };
    daySlots.forEach((slots, date) => {
      // Group consecutive slots within one boundary period; a gap in the
      // proposal always closes a block.
      let slotTimes: string[] = [];
      const flush = () => {
        if (!slotTimes.length) return;
        const startTime = slotTimes[0];
        const endTime = addMinutesToTime(slotTimes[slotTimes.length - 1], poll.slotInterval);
        const rowKey = slotKey(date, hourToTimeStr(boundaryOf(startTime) / 60));
        // A gap inside one period (only possible for quarter-hour polls) leaves
        // a second piece there; it keeps a row of its own rather than overwrite.
        const key = blocks.has(rowKey) ? slotKey(date, startTime) : rowKey;
        blocks.set(key, { date, startTime, endTime, slotTimes });
        slotTimes = [];
      };
      [...slots].forEach((time) => {
        const previous = slotTimes[slotTimes.length - 1];
        if (
          previous &&
          (addMinutesToTime(previous, poll.slotInterval) !== time || boundaryOf(previous) !== boundaryOf(time))
        ) {
          flush();
        }
        slotTimes.push(time);
      });
      flush();
    });
    const timeSlots = [...new Set([...blocks.keys()].map((key) => key.slice(key.indexOf('T') + 1)))].sort();
    const dateHeadings = new Map(poll.dates.map((date) => [date, formatDateHeading(date)]));
    const isProposed = (date: string, time: string) => blocks.has(slotKey(date, time));
    return { timeSlots, daySlots, blocks, dateHeadings, isProposed };
  }, [poll, gridInterval]);
}
