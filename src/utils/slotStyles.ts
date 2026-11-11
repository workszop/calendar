import type { SlotStatus } from '../types';

// ─── Shared slot presentation ───
// One source of truth for how a single participant's answer looks and reads, so
// the painter grid and the heatmap's participant-filter view can never drift.

export type SlotStatusOrNone = SlotStatus | 'none' | 'mixed';

export const SLOT_STATUS_LABEL: Record<SlotStatusOrNone, string> = {
  preferred: 'Preferred',
  available: 'Available',
  if_needed: 'If needed',
  unavailable: 'Busy',
  none: 'No answer',
  mixed: 'Mixed',
};

/** Calendar cell class for one participant's answer in a display cell. */
export const SLOT_STATUS_CELL_CLASS: Record<SlotStatusOrNone, string> = {
  preferred: 'd-calendar-cell--preferred',
  available: 'd-calendar-cell--available',
  if_needed: 'd-calendar-cell--if-needed',
  unavailable: 'd-calendar-cell--unavailable',
  none: 'd-calendar-cell--unanswered',
  mixed: 'd-calendar-cell--mixed',
};
