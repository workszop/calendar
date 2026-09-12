import { describe, expect, it } from 'vitest';
import type { Poll } from '../src/types';
import { analyzeSlot, findBestMeetingWindows, generateTimeSlots, isValidHourWindow } from '../src/utils/consensus';

const poll: Poll = {
  id: 'p1',
  title: 'Sync',
  description: '',
  durationMinutes: 60,
  timezone: 'UTC',
  dates: ['2026-10-01'],
  startHour: 9,
  endHour: 12,
  slotInterval: 30,
  creatorName: 'Ada',
  createdAt: '',
  finalizedSlot: null,
  participants: [
    { id: 'a', name: 'Ann', timezone: 'UTC', updatedAt: '', availability: {
      '2026-10-01T09:00': 'available', '2026-10-01T09:30': 'available',
      '2026-10-01T10:00': 'preferred', '2026-10-01T10:30': 'preferred' } },
    { id: 'b', name: 'Ben', timezone: 'UTC', updatedAt: '', availability: {
      '2026-10-01T10:00': 'available', '2026-10-01T10:30': 'available',
      '2026-10-01T11:00': 'if_needed' } },
  ],
};

describe('generateTimeSlots', () => {
  it('produces half-hour slots up to but excluding the end hour', () => {
    expect(generateTimeSlots(9, 11, 30)).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });
  it('supports half-hour boundaries', () => {
    expect(generateTimeSlots(9.5, 11, 30)).toEqual(['09:30', '10:00', '10:30']);
  });
  it('returns nothing for an empty range', () => {
    expect(generateTimeSlots(9, 9, 30)).toEqual([]);
  });
});

describe('analyzeSlot', () => {
  it('counts preferred as available and tracks names', () => {
    const a = analyzeSlot(poll, '2026-10-01', '10:00');
    expect(a.availableCount).toBe(2);
    expect(a.preferredCount).toBe(1);
    expect(a.attendanceRate).toBe(1);
    expect(a.availableNames).toEqual(['Ann', 'Ben']);
  });
  it('treats missing entries as unavailable', () => {
    const a = analyzeSlot(poll, '2026-10-01', '11:30');
    expect(a.availableCount).toBe(0);
    expect(a.unavailableCount).toBe(2);
  });
});

describe('findBestMeetingWindows', () => {
  it('ranks the window everyone can attend first', () => {
    const [best] = findBestMeetingWindows(poll);
    expect(best.startTime).toBe('10:00');
    expect(best.endTime).toBe('11:00');
    expect(best.allAvailable).toBe(true);
    expect(best.percentage).toBe(100);
  });
  it('scores every window at zero without participants', () => {
    const windows = findBestMeetingWindows({ ...poll, participants: [] });
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((w) => w.availableCount === 0 && w.percentage === 0)).toBe(true);
  });

  it('preserves a non-grid duration and checks every overlapping slot', () => {
    const duration45: Poll = {
      ...poll,
      durationMinutes: 45,
      participants: [
        {
          id: 'a',
          name: 'Ann',
          timezone: 'UTC',
          updatedAt: '',
          availability: {
            '2026-10-01T10:00': 'available',
            '2026-10-01T10:30': 'unavailable',
          },
        },
      ],
    };

    const ten = findBestMeetingWindows(duration45).find((window) => window.startTime === '10:00');
    expect(ten).toMatchObject({
      endTime: '10:45',
      availableCount: 0,
      unavailableAttendees: ['Ann'],
    });
  });

  it('does not propose a start whose exact duration crosses the day boundary', () => {
    const duration45: Poll = {
      ...poll,
      durationMinutes: 45,
      endHour: 12,
      participants: [],
    };

    const windows = findBestMeetingWindows(duration45);
    expect(windows.some((window) => window.startTime === '11:30')).toBe(false);
    expect(windows.find((window) => window.startTime === '11:00')?.endTime).toBe('11:45');
  });
});

describe('per-day hours', () => {
  const twoDay: Poll = {
    ...poll,
    dates: ['2026-10-01', '2026-10-02'],
    dayHours: { '2026-10-02': { startHour: 14, endHour: 16 } },
    participants: [],
  };
  it('uses the override for that date and the default elsewhere', async () => {
    const { generateDaySlots, generateAllTimeSlots } = await import('../src/utils/consensus');
    expect(generateDaySlots(twoDay, '2026-10-01')).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(generateDaySlots(twoDay, '2026-10-02')).toEqual(['14:00', '14:30', '15:00', '15:30']);
    expect(generateAllTimeSlots(twoDay)).toEqual([
      '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30',
    ]);
  });
  it('only proposes windows inside each day\'s hours', () => {
    const windows = findBestMeetingWindows(twoDay);
    const day2 = windows.filter((w) => w.date === '2026-10-02').map((w) => w.startTime);
    expect(day2).toEqual(['14:00', '14:30', '15:00']);
    expect(windows.some((w) => w.date === '2026-10-01' && w.startTime >= '12:00')).toBe(false);
  });
  it('ignores an inverted override', async () => {
    const { generateDaySlots } = await import('../src/utils/consensus');
    const bad = { ...twoDay, dayHours: { '2026-10-02': { startHour: 16, endHour: 14 } } };
    expect(generateDaySlots(bad, '2026-10-02')[0]).toBe('09:00');
  });
});

describe('isValidHourWindow', () => {
  it('accepts whole and half hours inside 0-24 with start before end', () => {
    expect(isValidHourWindow(9, 17)).toBe(true);
    expect(isValidHourWindow(9.5, 12.5)).toBe(true);
    expect(isValidHourWindow(0, 24)).toBe(true);
  });

  it('rejects inverted, empty, out-of-range and off-grid windows', () => {
    expect(isValidHourWindow(17, 9)).toBe(false);
    expect(isValidHourWindow(9, 9)).toBe(false);
    expect(isValidHourWindow(-1, 5)).toBe(false);
    expect(isValidHourWindow(9, 25)).toBe(false);
    expect(isValidHourWindow(9.25, 12)).toBe(false);
    expect(isValidHourWindow(Number.NaN, 12)).toBe(false);
  });
});
