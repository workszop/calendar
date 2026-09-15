import type { Poll, FinalizedSlot } from '../types';
import { downloadTextFile, fileSafeName } from './download';

// ─── Date headings ───
// Intl formatting is the hot path of every grid render, so results are cached
// per date string. Keys are stable identifiers, and the app runs in one locale
// per session, so the map never needs invalidating.
export interface DateHeading {
  weekday: string;
  dayMonth: string;
  full: string;
}

const dateHeadingCache = new Map<string, DateHeading>();

export function formatDateHeading(dateStr: string): DateHeading {
  const cached = dateHeadingCache.get(dateStr);
  if (cached) return cached;

  // dateStr format: YYYY-MM-DD
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  const heading: DateHeading = {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
    dayMonth: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    full: date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
  };
  dateHeadingCache.set(dateStr, heading);
  return heading;
}

export function formatTimeSlot(timeStr: string): string {
  // timeStr format: "HH:mm" (24h)
  const [h, m] = timeStr.split(':').map(Number);
  // 24:00 is the exclusive end-of-day marker, so it is midnight (AM), not
  // noon. Keeping the modulo here also makes labels graceful for an
  // intermediate value such as 24:30 while validation rejects it at the API.
  const hourWithinDay = ((h % 24) + 24) % 24;
  const period = hourWithinDay >= 12 ? 'PM' : 'AM';
  const displayHour = hourWithinDay % 12 === 0 ? 12 : hourWithinDay % 12;
  const displayMinute = m === 0 ? '00' : m < 10 ? `0${m}` : m;
  return `${displayHour}:${displayMinute} ${period}`;
}

export function addMinutesToTime(timeStr: string, minutesToAdd: number): string {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  // Do not wrap at midnight: 24:00 is a valid exclusive end marker for a
  // same-day meeting and wrapping it to 00:00 turns a valid window into an
  // inverted one.
  const newH = Math.floor(total / 60);
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// ─── Time zones ───
// Poll times are wall-clock values in the poll's IANA zone. Exports need real
// instants, so they convert through the zone's UTC offset as reported by Intl.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const zoneFormatterCache = new Map<string, Intl.DateTimeFormat | null>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (zoneFormatterCache.has(timeZone)) return zoneFormatterCache.get(timeZone)!;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // An unknown zone name: callers fall back to UTC.
  }
  zoneFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** Whether the runtime knows this IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  return Boolean(timeZone) && getZoneFormatter(timeZone) !== null;
}

/**
 * The zone's UTC offset in minutes at one instant, e.g. +120 for
 * Europe/Warsaw in summer and +330 for Asia/Kolkata. Unknown zones are UTC.
 */
export function getTimeZoneOffsetMinutes(timeZone: string, instant: Date): number {
  const formatter = getZoneFormatter(timeZone);
  if (!formatter) return 0;
  const parts: Record<string, number> = {};
  formatter.formatToParts(instant).forEach(({ type, value }) => {
    if (type !== 'literal') parts[type] = Number(value);
  });
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSeconds) / MINUTE_MS);
}

/**
 * Convert a wall-clock date ("YYYY-MM-DD") and time ("HH:mm", 24:00 allowed as
 * next-day midnight) in an IANA zone to the UTC instant it names.
 *
 * DST edges resolve like Temporal's `disambiguation: 'compatible'`:
 * - a time inside an overlap (clocks go back, the time happens twice) maps to
 *   the earlier instant, i.e. the one still using the pre-transition offset;
 * - a time inside a gap (clocks go forward, the time never happens) is moved
 *   forward by the gap length, e.g. 02:30 in Europe/Warsaw on the spring
 *   change becomes 03:30 local (01:30 UTC).
 * Unknown zone names are treated as UTC.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  // Date.UTC rolls hour 24 over to the next day on its own.
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Transitions are months apart, so a day either side sees at most one change.
  const offsetBefore = getTimeZoneOffsetMinutes(timeZone, new Date(wallAsUtc - DAY_MS));
  const offsetAfter = getTimeZoneOffsetMinutes(timeZone, new Date(wallAsUtc + DAY_MS));
  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => wallAsUtc - offset * MINUTE_MS)
    .filter((instant) => wallAsUtc - getTimeZoneOffsetMinutes(timeZone, new Date(instant)) * MINUTE_MS === instant)
    .sort((a, b) => a - b);

  if (candidates.length) return new Date(candidates[0]);
  // Gap: apply the offset in force before the jump, which lands after it.
  return new Date(wallAsUtc - offsetBefore * MINUTE_MS);
}

/** A UTC instant in the iCalendar/Google compact form, e.g. "20261001T073000Z". */
export function toCompactUtc(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** A UTC instant as ISO 8601 without milliseconds, e.g. "2026-10-01T07:30:00Z". */
function toIsoUtc(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The meeting's start and end for a calendar export. With a zone this runtime
 * knows they are UTC instants ("...Z"). With an unknown zone name the wall
 * clock is exported as floating time (no "Z"), which calendars read in the
 * viewer's own zone: not certain to be right, but never the silent hours-off
 * shift that stamping the wall clock as UTC would give.
 */
function exportStamps(poll: Poll, slot: FinalizedSlot): { compact: [string, string]; iso: [string, string] } {
  const zone = isValidTimeZone(poll.timezone) ? poll.timezone : 'UTC';
  const start = zonedTimeToUtc(slot.date, slot.startTime, zone);
  const end = zonedTimeToUtc(slot.date, slot.endTime, zone);
  const floating = zone !== poll.timezone;
  const compact = (instant: Date) => (floating ? toCompactUtc(instant).slice(0, -1) : toCompactUtc(instant));
  const iso = (instant: Date) => (floating ? toIsoUtc(instant).slice(0, -1) : toIsoUtc(instant));
  return { compact: [compact(start), compact(end)], iso: [iso(start), iso(end)] };
}

/** The browser's own IANA zone, or UTC when the runtime does not say. */
export function getViewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatOffsetDistance(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!rest) return `${hours} h`;
  return hours ? `${hours} h ${rest} min` : `${rest} min`;
}

function describeOffsetDistance(difference: number): string {
  if (difference === 0) return 'the same time';
  return `${formatOffsetDistance(Math.abs(difference))} ${difference < 0 ? 'earlier' : 'later'}`;
}

/**
 * A short hint comparing the viewer's clock with the poll zone on the poll's
 * own dates (at noon in the poll zone), e.g. "your time is 6 h earlier". When
 * a DST change moves the gap between the dates, each change is named once:
 * "your time is 6 h later (5 h from Oct 26)". Without dates the offsets in
 * force at `now` are used. Null when both zones are the same name.
 */
export function describeTimeZoneDifference(
  pollTimeZone: string,
  viewerTimeZone: string,
  dates: readonly string[] = [],
  now: Date = new Date()
): string | null {
  if (!pollTimeZone || pollTimeZone === viewerTimeZone) return null;
  const differenceAt = (instant: Date) =>
    getTimeZoneOffsetMinutes(viewerTimeZone, instant) - getTimeZoneOffsetMinutes(pollTimeZone, instant);
  const sorted = [...new Set(dates)].sort();
  const points = sorted.length
    ? sorted.map((date) => ({ date, difference: differenceAt(zonedTimeToUtc(date, '12:00', pollTimeZone)) }))
    : [{ date: '', difference: differenceAt(now) }];

  const [first, ...rest] = points;
  const changes: string[] = [];
  let previous = first.difference;
  for (const { date, difference } of rest) {
    if (difference === previous) continue;
    // Same direction as before: the distance alone is enough.
    const sameDirection = Math.sign(difference) === Math.sign(previous) && difference !== 0;
    const label = sameDirection ? formatOffsetDistance(Math.abs(difference)) : describeOffsetDistance(difference);
    changes.push(`${label} from ${formatDateHeading(date).dayMonth}`);
    previous = difference;
  }

  const base =
    first.difference === 0 ? 'your clock shows the same time' : `your time is ${describeOffsetDistance(first.difference)}`;
  return changes.length ? `${base} (${changes.join(', ')})` : base;
}

export function generateGoogleCalendarUrl(poll: Poll, slot: FinalizedSlot): string {
  const { compact } = exportStamps(poll, slot);

  const title = encodeURIComponent(poll.title);
  const details = encodeURIComponent(
    `${poll.description ? poll.description + '\n\n' : ''}Agreed via TimeSync Poll: ${window.location.href}\nConfirmed by: ${slot.confirmedBy}`
  );
  const location = encodeURIComponent(poll.location || '');
  const zone = isValidTimeZone(poll.timezone) ? `&ctz=${encodeURIComponent(poll.timezone)}` : '';

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${compact[0]}/${compact[1]}&details=${details}&location=${location}${zone}`;
}

export function generateOutlookUrl(poll: Poll, slot: FinalizedSlot): string {
  const { iso } = exportStamps(poll, slot);

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: poll.title,
    startdt: iso[0],
    enddt: iso[1],
    body: `${poll.description || ''}\n\nAgreed timing poll: ${window.location.href}`,
    location: poll.location || '',
  });

  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** Escape an RFC 5545 TEXT value before putting it on a content line. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/([,;])/g, '\\$1');
}

/**
 * Fold an iCalendar content line at 75 UTF-8 octets, as required by RFC 5545.
 * Continuation lines include their leading space in the 75-octet limit.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const segments: string[] = [];
  let remaining = line;
  let first = true;

  while (remaining.length > 0) {
    const maxBytes = first ? 75 : 74;
    let segment = '';
    let consumed = 0;

    for (const character of remaining) {
      const candidate = segment + character;
      if (encoder.encode(candidate).length > maxBytes) break;
      segment = candidate;
      consumed += character.length;
    }

    // A Unicode code point is at most four UTF-8 octets, so this is only a
    // defensive guard against an unexpected TextEncoder implementation.
    if (!segment) throw new Error('Unable to fold iCalendar content line');
    segments.push(segment);
    remaining = remaining.slice(consumed);
    first = false;
  }

  return segments.map((segment, index) => (index === 0 ? segment : ` ${segment}`)).join('\r\n');
}

function stableIcsUid(poll: Poll, slot: FinalizedSlot): string {
  const compactDate = slot.date.replace(/-/g, '');
  const compactTime = slot.startTime.replace(':', '');
  return `${poll.id}-${compactDate}T${compactTime}@timesync.app`;
}

/** Build an RFC 5545 calendar object for deterministic, testable exports. */
export function generateIcsContent(poll: Poll, slot: FinalizedSlot): string {
  const { compact } = exportStamps(poll, slot);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TimeSync//Meeting Poll//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${stableIcsUid(poll, slot)}`,
    `DTSTAMP:${toCompactUtc(new Date())}`,
    `DTSTART:${compact[0]}`,
    `DTEND:${compact[1]}`,
    `SUMMARY:${escapeIcsText(poll.title)}`,
    `DESCRIPTION:${escapeIcsText(poll.description || '')}`,
    `LOCATION:${escapeIcsText(poll.location || '')}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

export function downloadIcsFile(poll: Poll, slot: FinalizedSlot) {
  downloadTextFile(
    `${fileSafeName(poll.title)}_Meeting.ics`,
    generateIcsContent(poll, slot),
    'text/calendar;charset=utf-8'
  );
}

// Local YYYY-MM-DD (never toISOString - that shifts to UTC and can slip a day)
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Decimal hour -> "HH:mm" (9.5 -> "09:30", 17 -> "17:00")
export function hourToTimeStr(h: number): string {
  const totalMinutes = Math.round(h * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Decimal hour -> human label, e.g. 9.5 -> "9:30 AM"
export function formatHour(h: number): string {
  return formatTimeSlot(hourToTimeStr(h));
}
