import type { Poll, SlotStatus } from '../types';
import { analyzeWindow, slotKey } from './consensus';

export type GridInterval = 30 | 60;

export interface GridBlock {
  date: string;
  startTime: string;
  endTime: string;
  slotTimes: string[];
}

/** Display-only state. Mixed is never stored as a participant answer. */
export function getBlockStatus(availability: Record<string, SlotStatus>, block: GridBlock): SlotStatus | 'none' | 'mixed' {
  const statuses = block.slotTimes.map((time) => availability[slotKey(block.date, time)]);
  if (statuses.every((status) => status === statuses[0])) return statuses[0] ?? 'none';
  return 'mixed';
}

/** A participant counts as available only when they can attend the entire block. */
export function analyzeGridBlock(poll: Poll, block: GridBlock) {
  return analyzeWindow(poll, block.date, block.startTime, block.slotTimes);
}
