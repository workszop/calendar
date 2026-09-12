import { useMemo } from 'react';
import type { Poll } from '../types';
import { addMinutesToTime, formatDateHeading } from '../utils/calendar';
import { generateDaySlots, slotKey } from '../utils/consensus';
import type { GridBlock, GridInterval } from '../utils/grid';

export interface PollGrid {
  /** Union of every date's slots - the grid rows, "HH:mm" sorted. */
  timeSlots: string[];
  /** date -> set of times proposed on that date. */
  daySlots: Map<string, Set<string>>;
  /** Display cells mapped to their unchanged underlying atomic slots. */
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
    const slotsPerBlock = (gridInterval ?? poll.slotInterval) / poll.slotInterval;
    daySlots.forEach((slots, date) => {
      const times = [...slots];
      for (let index = 0; index < times.length; index += slotsPerBlock) {
        const slotTimes = times.slice(index, index + slotsPerBlock);
        const startTime = slotTimes[0];
        const endTime = addMinutesToTime(slotTimes[slotTimes.length - 1], poll.slotInterval);
        blocks.set(slotKey(date, startTime), { date, startTime, endTime, slotTimes });
      }
    });
    const timeSlots = [...new Set([...blocks.values()].map((block) => block.startTime))].sort();
    const dateHeadings = new Map(poll.dates.map((date) => [date, formatDateHeading(date)]));
    const isProposed = (date: string, time: string) => blocks.has(slotKey(date, time));
    return { timeSlots, daySlots, blocks, dateHeadings, isProposed };
  }, [poll, gridInterval]);
}
