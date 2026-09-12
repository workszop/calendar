import { describe, expect, it, vi } from 'vitest';
import {
  addMinutesToTime,
  formatHour,
  formatTimeSlot,
  generateIcsContent,
  generateOutlookUrl,
  hourToTimeStr,
  toCompactIso,
  toDateStr,
} from '../src/utils/calendar';
import type { FinalizedSlot, Poll } from '../src/types';
import { slotKey } from '../src/utils/consensus';

const poll: Poll = {
  id: 'poll_calendar',
  title: 'Planning, review; Q4',
  description: 'Line one\nLine two, with a semicolon; and a \\ slash',
  location: 'Room, A; floor 2',
  durationMinutes: 30,
  timezone: 'UTC',
  dates: ['2026-10-01'],
  startHour: 9,
  endHour: 17,
  slotInterval: 30,
  creatorName: 'Ada',
  createdAt: '2026-09-01T00:00:00.000Z',
  finalizedSlot: null,
  participants: [],
};

const slot: FinalizedSlot = {
  date: '2026-10-01',
  startTime: '23:30',
  endTime: '24:00',
  confirmedBy: 'Ada',
  confirmedAt: '2026-10-01T12:00:00.000Z',
};

describe('toDateStr', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(toDateStr(new Date(2026, 8, 12))).toBe('2026-09-12');
    expect(toDateStr(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(toDateStr(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('uses local time, not UTC (late evening does not roll over)', () => {
    expect(toDateStr(new Date(2026, 5, 15, 23, 59))).toBe('2026-06-15');
    expect(toDateStr(new Date(2026, 5, 15, 0, 1))).toBe('2026-06-15');
  });
});

describe('hourToTimeStr', () => {
  it('renders whole and half hours', () => {
    expect(hourToTimeStr(9.5)).toBe('09:30');
    expect(hourToTimeStr(17)).toBe('17:00');
    expect(hourToTimeStr(0)).toBe('00:00');
    expect(hourToTimeStr(0.5)).toBe('00:30');
    expect(hourToTimeStr(24)).toBe('24:00');
  });
});

describe('formatHour', () => {
  it('renders a 12-hour label', () => {
    expect(formatHour(9.5)).toBe('9:30 AM');
    expect(formatHour(17)).toBe('5:00 PM');
    expect(formatHour(12)).toBe('12:00 PM');
    expect(formatHour(0)).toBe('12:00 AM');
  });
});

describe('time arithmetic and display', () => {
  it('keeps an end-of-day result at 24:00 instead of wrapping to midnight', () => {
    expect(addMinutesToTime('23:30', 30)).toBe('24:00');
  });

  it('formats 24:00 as midnight rather than noon', () => {
    expect(formatTimeSlot('24:00')).toBe('12:00 AM');
  });
});

describe('slotKey', () => {
  it('joins date and time with a T', () => {
    expect(slotKey('2026-10-01', '10:00')).toBe('2026-10-01T10:00');
    expect(slotKey('2026-10-01', '09:30')).toBe('2026-10-01T09:30');
  });
});

describe('toCompactIso', () => {
  it('joins a date and a time into the calendar wire format', () => {
    expect(toCompactIso('2026-10-01', '09:30')).toBe('20261001T093000');
    expect(toCompactIso('2026-12-31', '23:00')).toBe('20261231T230000');
    expect(toCompactIso('2026-01-05', '00:00')).toBe('20260105T000000');
  });

  it('normalizes the exclusive 24:00 end to the next calendar day', () => {
    expect(toCompactIso('2026-10-01', '24:00')).toBe('20261002T000000');
  });
});

describe('iCalendar export', () => {
  it('escapes text values and uses a stable UID', () => {
    const first = generateIcsContent(poll, slot);
    const second = generateIcsContent(poll, slot);

    expect(first.match(/^UID:(.*)$/m)?.[1]).toBe('poll_calendar-20261001T2330@timesync.app');
    expect(second.match(/^UID:(.*)$/m)?.[1]).toBe('poll_calendar-20261001T2330@timesync.app');
    expect(first).toContain('SUMMARY:Planning\\, review\\; Q4');
    expect(first).toContain('DESCRIPTION:Line one\\nLine two\\, with a semicolon\\; and a \\\\ slash');
    expect(first).toContain('LOCATION:Room\\, A\\; floor 2');
    expect(first).toContain('DTSTART:20261001T233000');
    expect(first).toContain('DTEND:20261002T000000');
    expect(first).not.toContain('\r\nX-');
  });

  it('folds every physical content line to at most 75 UTF-8 octets', () => {
    const longPoll = { ...poll, title: 'Ż'.repeat(100), description: 'ą'.repeat(100) };
    const content = generateIcsContent(longPoll, {
      ...slot,
      endTime: '12:00',
    });

    for (const line of content.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('calendar provider URLs', () => {
  it('normalizes 24:00 to next-day midnight for Outlook', () => {
    vi.stubGlobal('window', { location: { href: 'https://timesync.test/poll' } });
    try {
      const url = new URL(generateOutlookUrl(poll, slot));
      expect(url.searchParams.get('startdt')).toBe('2026-10-01T23:30:00');
      expect(url.searchParams.get('enddt')).toBe('2026-10-02T00:00:00');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
