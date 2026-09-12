import type { SlotStatus } from '../types';

// ─── Shared slot presentation ───
// One source of truth for how a single participant's answer looks and reads, so
// the painter grid and the heatmap's participant-filter view can never drift.

export type SlotStatusOrNone = SlotStatus | 'none' | 'mixed';

export const SLOT_STATUS_CLASS: Record<SlotStatusOrNone, string> = {
  preferred: 'bg-amber-400 border-amber-500 text-stone-900 font-bold',
  available: 'bg-emerald-700 border-emerald-800 text-white font-semibold',
  if_needed: 'bg-amber-200 border-amber-300 text-stone-900 font-medium',
  unavailable: 'bg-stone-200 border-stone-300 text-stone-600 hover:bg-stone-300',
  // Proposed by the organizer, not answered yet
  none: 'bg-white border-dashed border-stone-300 text-stone-500 hover:bg-stone-50',
  mixed: 'bg-stone-50 border-dashed border-stone-500 text-stone-800 font-semibold',
};

export const SLOT_STATUS_LABEL: Record<SlotStatusOrNone, string> = {
  preferred: 'Preferred',
  available: 'Available',
  if_needed: 'If needed',
  unavailable: 'Busy',
  none: 'No answer',
  mixed: 'Mixed',
};
