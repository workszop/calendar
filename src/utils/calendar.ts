import type { Poll, FinalizedSlot } from '../types';

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

interface CalendarDateTime {
  date: string;
  time: string;
}

/** Normalize the floating local calendar value 24:00 to next-day midnight. */
function normalizeCalendarDateTime(date: string, time: string): CalendarDateTime {
  if (time !== '24:00') return { date, time };

  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return { date: parsed.toISOString().slice(0, 10), time: '00:00' };
}

// "2026-10-01" + "09:30" -> "20261001T093000" (calendar wire format)
export function toCompactIso(date: string, time: string): string {
  const normalized = normalizeCalendarDateTime(date, time);
  const [year, month, day] = normalized.date.split('-');
  const [hour, minute] = normalized.time.split(':');
  return `${year}${month}${day}T${hour}${minute}00`;
}

function toCalendarDateTime(date: string, time: string): string {
  const normalized = normalizeCalendarDateTime(date, time);
  return `${normalized.date}T${normalized.time}:00`;
}

export function generateGoogleCalendarUrl(poll: Poll, slot: FinalizedSlot): string {
  const startIso = toCompactIso(slot.date, slot.startTime);
  const endIso = toCompactIso(slot.date, slot.endTime);

  const title = encodeURIComponent(poll.title);
  const details = encodeURIComponent(
    `${poll.description ? poll.description + '\n\n' : ''}Agreed via TimeSync Poll: ${window.location.href}\nConfirmed by: ${slot.confirmedBy}`
  );
  const location = encodeURIComponent(poll.location || '');

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startIso}/${endIso}&details=${details}&location=${location}`;
}

export function generateOutlookUrl(poll: Poll, slot: FinalizedSlot): string {
  const startDateTime = toCalendarDateTime(slot.date, slot.startTime);
  const endDateTime = toCalendarDateTime(slot.date, slot.endTime);

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: poll.title,
    startdt: startDateTime,
    enddt: endDateTime,
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

function formatIcsUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Build an RFC 5545 calendar object for deterministic, testable exports. */
export function generateIcsContent(poll: Poll, slot: FinalizedSlot): string {
  const startIso = toCompactIso(slot.date, slot.startTime);
  const endIso = toCompactIso(slot.date, slot.endTime);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TimeSync//Meeting Poll//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${stableIcsUid(poll, slot)}`,
    `DTSTAMP:${formatIcsUtcTimestamp(new Date())}`,
    `DTSTART:${startIso}`,
    `DTEND:${endIso}`,
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
  const icsContent = generateIcsContent(poll, slot);

  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${poll.title.replace(/[^a-zA-Z0-9]/g, '_')}_Meeting.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking synchronously cancels the download in Safari and some Firefox builds.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
