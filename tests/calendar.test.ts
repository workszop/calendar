import { describe, expect, it, vi } from 'vitest';
import {
  addMinutesToTime,
  describeTimeZoneDifference,
  formatDateHeading,
  formatHour,
  formatTimeSlot,
  generateGoogleCalendarUrl,
  generateIcsContent,
  generateOutlookUrl,
  hourToTimeStr,
  toDateStr,
  zonedTimeToUtc,
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

describe('iCalendar export', () => {
  it('escapes text values and uses a stable UID', () => {
    const first = generateIcsContent(poll, slot);
    const second = generateIcsContent(poll, slot);

    expect(first.match(/^UID:(.*)$/m)?.[1]).toBe('poll_calendar-20261001T2330@timesync.app');
    expect(second.match(/^UID:(.*)$/m)?.[1]).toBe('poll_calendar-20261001T2330@timesync.app');
    expect(first).toContain('SUMMARY:Planning\\, review\\; Q4');
    expect(first).toContain('DESCRIPTION:Line one\\nLine two\\, with a semicolon\\; and a \\\\ slash');
    expect(first).toContain('LOCATION:Room\\, A\\; floor 2');
    expect(first).toContain('DTSTART:20261001T233000Z');
    expect(first).toContain('DTEND:20261002T000000Z');
    expect(first).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/m);
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
      expect(url.searchParams.get('startdt')).toBe('2026-10-01T23:30:00Z');
      expect(url.searchParams.get('enddt')).toBe('2026-10-02T00:00:00Z');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('zonedTimeToUtc', () => {
  const iso = (date: string, time: string, zone: string) => zonedTimeToUtc(date, time, zone).toISOString();

  it('converts wall-clock times using the zone offset on that date', () => {
    expect(iso('2026-07-01', '09:00', 'Europe/Warsaw')).toBe('2026-07-01T07:00:00.000Z');
    expect(iso('2026-12-01', '09:00', 'Europe/Warsaw')).toBe('2026-12-01T08:00:00.000Z');
    expect(iso('2026-10-01', '09:00', 'America/New_York')).toBe('2026-10-01T13:00:00.000Z');
    expect(iso('2026-10-01', '09:00', 'UTC')).toBe('2026-10-01T09:00:00.000Z');
    expect(iso('2026-10-01', '09:00', 'Asia/Kolkata')).toBe('2026-10-01T03:30:00.000Z');
  });

  it('treats 24:00 as the next midnight in the zone', () => {
    expect(iso('2026-10-01', '24:00', 'Asia/Kolkata')).toBe('2026-10-01T18:30:00.000Z');
  });

  it('moves a time inside a spring-forward gap forward by the gap length', () => {
    // Europe/Warsaw jumps from 02:00 to 03:00 on 2026-03-29.
    expect(iso('2026-03-29', '02:30', 'Europe/Warsaw')).toBe('2026-03-29T01:30:00.000Z');
    expect(iso('2026-03-29', '03:00', 'Europe/Warsaw')).toBe('2026-03-29T01:00:00.000Z');
    // America/New_York jumps from 02:00 to 03:00 on 2026-03-08.
    expect(iso('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('picks the earlier instant for a time repeated by a fall-back overlap', () => {
    // Europe/Warsaw repeats 02:00-03:00 on 2026-10-25.
    expect(iso('2026-10-25', '02:30', 'Europe/Warsaw')).toBe('2026-10-25T00:30:00.000Z');
    expect(iso('2026-10-25', '03:00', 'Europe/Warsaw')).toBe('2026-10-25T02:00:00.000Z');
    // America/New_York repeats 01:00-02:00 on 2026-11-01.
    expect(iso('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('falls back to UTC for an unknown zone name', () => {
    expect(iso('2026-10-01', '09:00', 'Not/AZone')).toBe('2026-10-01T09:00:00.000Z');
  });
});

describe('zoned calendar exports', () => {
  const zonedSlot = (date: string, startTime: string, endTime: string): FinalizedSlot => ({
    date, startTime, endTime, confirmedBy: 'Ada', confirmedAt: '',
  });

  function exportsFor(timezone: string, exportSlot: FinalizedSlot) {
    vi.stubGlobal('window', { location: { href: 'https://timesync.test/poll' } });
    try {
      const zoned = { ...poll, timezone };
      const ics = generateIcsContent(zoned, exportSlot);
      const google = new URL(generateGoogleCalendarUrl(zoned, exportSlot));
      const outlook = new URL(generateOutlookUrl(zoned, exportSlot));
      return {
        dtstart: ics.match(/^DTSTART:(.*)\r$/m)?.[1],
        dtend: ics.match(/^DTEND:(.*)\r$/m)?.[1],
        googleDates: google.searchParams.get('dates'),
        ctz: google.searchParams.get('ctz'),
        startdt: outlook.searchParams.get('startdt'),
        enddt: outlook.searchParams.get('enddt'),
      };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('exports Europe/Warsaw in UTC on both sides of the autumn DST change', () => {
    expect(exportsFor('Europe/Warsaw', zonedSlot('2026-10-24', '09:00', '10:00'))).toEqual({
      dtstart: '20261024T070000Z',
      dtend: '20261024T080000Z',
      googleDates: '20261024T070000Z/20261024T080000Z',
      ctz: 'Europe/Warsaw',
      startdt: '2026-10-24T07:00:00Z',
      enddt: '2026-10-24T08:00:00Z',
    });
    expect(exportsFor('Europe/Warsaw', zonedSlot('2026-10-26', '09:00', '10:00'))).toMatchObject({
      dtstart: '20261026T080000Z',
      googleDates: '20261026T080000Z/20261026T090000Z',
      startdt: '2026-10-26T08:00:00Z',
    });
  });

  it('keeps a meeting across the overlap night at its real length', () => {
    // 01:30-03:30 local on the fall-back night lasts three real hours.
    expect(exportsFor('Europe/Warsaw', zonedSlot('2026-10-25', '01:30', '03:30'))).toMatchObject({
      dtstart: '20261024T233000Z',
      dtend: '20261025T023000Z',
    });
  });

  it('exports America/New_York, UTC and a half-hour zone', () => {
    expect(exportsFor('America/New_York', zonedSlot('2026-10-01', '09:00', '09:30'))).toEqual({
      dtstart: '20261001T130000Z',
      dtend: '20261001T133000Z',
      googleDates: '20261001T130000Z/20261001T133000Z',
      ctz: 'America/New_York',
      startdt: '2026-10-01T13:00:00Z',
      enddt: '2026-10-01T13:30:00Z',
    });
    expect(exportsFor('UTC', zonedSlot('2026-10-01', '09:00', '09:30'))).toMatchObject({
      dtstart: '20261001T090000Z',
      ctz: 'UTC',
      startdt: '2026-10-01T09:00:00Z',
    });
    expect(exportsFor('Asia/Kolkata', zonedSlot('2026-10-01', '23:30', '24:00'))).toEqual({
      dtstart: '20261001T180000Z',
      dtend: '20261001T183000Z',
      googleDates: '20261001T180000Z/20261001T183000Z',
      ctz: 'Asia/Kolkata',
      startdt: '2026-10-01T18:00:00Z',
      enddt: '2026-10-01T18:30:00Z',
    });
  });

  it('exports an unknown zone as floating wall-clock time instead of stamping it UTC', () => {
    expect(exportsFor('Not/AZone', zonedSlot('2026-10-01', '23:30', '24:00'))).toEqual({
      dtstart: '20261001T233000',
      dtend: '20261002T000000',
      googleDates: '20261001T233000/20261002T000000',
      ctz: null,
      startdt: '2026-10-01T23:30:00',
      enddt: '2026-10-02T00:00:00',
    });
  });
});

describe('describeTimeZoneDifference', () => {
  const summer = new Date('2026-07-01T12:00:00Z');

  it('says nothing when the viewer is in the poll zone', () => {
    expect(describeTimeZoneDifference('Europe/Warsaw', 'Europe/Warsaw', ['2026-07-01'])).toBeNull();
  });

  it('describes the offset difference from the viewer side', () => {
    expect(describeTimeZoneDifference('Europe/Warsaw', 'America/New_York', ['2026-07-01'])).toBe('your time is 6 h earlier');
    expect(describeTimeZoneDifference('Europe/Warsaw', 'Asia/Kolkata', ['2026-07-01'])).toBe('your time is 3 h 30 min later');
    expect(describeTimeZoneDifference('UTC', 'Europe/London', ['2026-01-15'])).toBe('your clock shows the same time');
    // Without dates it falls back to the offsets at `now`.
    expect(describeTimeZoneDifference('Europe/Warsaw', 'America/New_York', [], summer)).toBe('your time is 6 h earlier');
  });

  it("uses the poll's dates, not today's offsets", () => {
    // In July New York is 6 h behind Warsaw, but a poll in the week after the EU
    // clock change (25 Oct) and before the US one (1 Nov) is only 5 h apart.
    expect(describeTimeZoneDifference('Europe/Warsaw', 'America/New_York', ['2026-10-27', '2026-10-29'], summer)).toBe(
      'your time is 5 h earlier'
    );
  });

  it('names each change when the poll spans a DST change in one zone', () => {
    const { dayMonth: oct26 } = formatDateHeading('2026-10-26');
    const { dayMonth: nov2 } = formatDateHeading('2026-11-02');
    expect(describeTimeZoneDifference('America/New_York', 'Europe/Warsaw', ['2026-10-26', '2026-10-20'])).toBe(
      `your time is 6 h later (5 h from ${oct26})`
    );
    expect(
      describeTimeZoneDifference('Europe/Warsaw', 'America/New_York', ['2026-10-20', '2026-10-26', '2026-11-02'])
    ).toBe(`your time is 6 h earlier (5 h from ${oct26}, 6 h from ${nov2})`);
    // Spring: the US moves on 8 Mar, the EU on 29 Mar; London starts level with UTC.
    const { dayMonth: mar30 } = formatDateHeading('2026-03-30');
    expect(describeTimeZoneDifference('UTC', 'Europe/London', ['2026-03-20', '2026-03-30'])).toBe(
      `your clock shows the same time (1 h later from ${mar30})`
    );
  });
});
