import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { usePollGrid } from '../../src/hooks/usePollGrid';
import type { Poll } from '../../src/types';

afterEach(cleanup);

const poll: Poll = {
  id: 'grid', title: 'Grid', description: '', durationMinutes: 45, timezone: 'UTC',
  dates: ['2026-10-01'], startHour: 9, endHour: 11, slotInterval: 30,
  creatorName: 'Test', createdAt: '', participants: [],
};

describe('grid display intervals', () => {
  it('groups hourly rows without modifying atomic slots or meeting duration', () => {
    const before = structuredClone(poll);
    const { result, rerender } = renderHook(({ interval }: { interval: 30 | 60 }) =>
      usePollGrid(poll, interval), { initialProps: { interval: 30 } });
    expect(result.current.timeSlots).toEqual(['09:00', '09:30', '10:00', '10:30']);
    rerender({ interval: 60 });
    expect(result.current.timeSlots).toEqual(['09:00', '10:00']);
    expect([...result.current.daySlots.get('2026-10-01')!]).toEqual(['09:00', '09:30', '10:00', '10:30']);
    expect(poll).toEqual(before);
    rerender({ interval: 30 });
    expect(result.current.timeSlots).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });

  it('preserves partial final hours and dates with different proposed hours', () => {
    const { result } = renderHook(() => usePollGrid({
      ...poll, dates: ['2026-10-01', '2026-10-02'], endHour: 10.5,
      dayHours: { '2026-10-02': { startHour: 13.5, endHour: 15 } },
    }, 60));
    expect(result.current.timeSlots).toEqual(['09:00', '10:00', '13:30', '14:30']);
    expect(result.current.blocks.get('2026-10-01T10:00')).toEqual({
      date: '2026-10-01', startTime: '10:00', endTime: '10:30', slotTimes: ['10:00'],
    });
    expect(result.current.blocks.get('2026-10-02T14:30')?.endTime).toBe('15:00');
    expect(result.current.isProposed('2026-10-02', '09:00')).toBe(false);
  });

  it('groups existing quarter-hour polls without dropping any votes', () => {
    const { result } = renderHook(() => usePollGrid({ ...poll, slotInterval: 15, endHour: 10 }, 60));
    expect(result.current.timeSlots).toEqual(['09:00']);
    expect(result.current.blocks.get('2026-10-01T09:00')?.slotTimes).toEqual(['09:00', '09:15', '09:30', '09:45']);
  });
  it('closes an hourly block at a gap in proposed slots', () => {
    const { result } = renderHook(() => usePollGrid({
      ...poll, proposedSlots: { '2026-10-01': ['09:30', '10:00', '10:30', '13:00'] },
    }, 60));
    expect([...result.current.blocks.values()].map((b) => b.slotTimes)).toEqual([
      ['09:30', '10:00'], ['10:30'], ['13:00'],
    ]);
    expect(result.current.isProposed('2026-10-01', '11:00')).toBe(false);
  });
});
