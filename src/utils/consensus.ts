import type { DayHours, Poll, SlotAnalysis } from '../types';
import { formatTimeSlot, addMinutesToTime, hourToTimeStr } from './calendar';

export interface MeetingWindowOption {
  date: string;
  startTime: string; // "10:00"
  endTime: string;   // "11:00"
  displayRange: string; // "10:00 AM – 11:00 AM"
  availableCount: number;
  totalParticipants: number;
  percentage: number; // 0-100
  allAvailable: boolean;
  score: number;
  availableAttendees: string[];
  preferredAttendees: string[];
  ifNeededAttendees: string[];
  unavailableAttendees: string[];
}

export interface MeetingWindow {
  startTime: string;
  endTime: string;
  slotTimes: string[];
}

// Canonical availability map key for one atomic slot
export function slotKey(date: string, time: string): string {
  return `${date}T${time}`;
}

// A whole or half hour inside 0-24, e.g. 9, 9.5, 24
export function isHalfHourValue(h: unknown): h is number {
  return typeof h === 'number' && Number.isFinite(h) && Number.isInteger(h * 2) && h >= 0 && h <= 24;
}

// A usable hour window: two half-hour values with start before end.
export function isValidHourWindow(start: number, end: number): boolean {
  return isHalfHourValue(start) && isHalfHourValue(end) && start < end;
}

// Generate array of "HH:mm" from startHour to endHour
export function generateTimeSlots(startHour: number, endHour: number, intervalMinutes: number): string[] {
  const slots: string[] = [];
  const totalMinutesStart = startHour * 60;
  const totalMinutesEnd = endHour * 60;

  for (let m = totalMinutesStart; m < totalMinutesEnd; m += intervalMinutes) {
    slots.push(hourToTimeStr(m / 60));
  }
  return slots;
}

// Hour window for one date: its override, or the poll-wide default
export function getDayHours(poll: Poll, date: string): DayHours {
  const override = poll.dayHours?.[date];
  if (override && isValidHourWindow(override.startHour, override.endHour)) return override;
  return { startHour: poll.startHour, endHour: poll.endHour };
}

// Slots suggested for one date
export function generateDaySlots(poll: Poll, date: string): string[] {
  const { startHour, endHour } = getDayHours(poll, date);
  return generateTimeSlots(startHour, endHour, poll.slotInterval);
}

// Union of every date's slots - the grid rows
export function generateAllTimeSlots(poll: Poll): string[] {
  const set = new Set<string>();
  poll.dates.forEach((d) => generateDaySlots(poll, d).forEach((t) => set.add(t)));
  return [...set].sort();
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Resolve the atomic grid slots covered by one exact-duration meeting.
 * Returns null when the start is not a proposed slot or the meeting would
 * cross that date's availability window.
 */
export function getMeetingWindow(poll: Poll, date: string, startTime: string): MeetingWindow | null {
  const duration = poll.durationMinutes || 30;
  const interval = poll.slotInterval || 30;
  const { startHour, endHour } = getDayHours(poll, date);
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = startMinutes + duration;

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(interval) ||
    interval <= 0 ||
    startMinutes < startHour * 60 ||
    endMinutes > endHour * 60
  ) {
    return null;
  }

  const daySlots = generateDaySlots(poll, date);
  const startIndex = daySlots.indexOf(startTime);
  if (startIndex < 0) return null;

  const slotsNeeded = Math.max(1, Math.ceil(duration / interval));
  const slotTimes = daySlots.slice(startIndex, startIndex + slotsNeeded);
  if (slotTimes.length !== slotsNeeded) return null;

  return {
    startTime,
    endTime: addMinutesToTime(startTime, duration),
    slotTimes,
  };
}

// Analyze single atomic slot
export function analyzeSlot(poll: Poll, date: string, timeStr: string): SlotAnalysis {
  const key = slotKey(date, timeStr);
  const total = poll.participants.length;

  const availableNames: string[] = [];
  const preferredNames: string[] = [];
  const ifNeededNames: string[] = [];
  const unavailableNames: string[] = [];

  let availableCount = 0;
  let preferredCount = 0;
  let ifNeededCount = 0;
  let unavailableCount = 0;

  poll.participants.forEach((p) => {
    const status = p.availability[key];
    if (status === 'preferred') {
      preferredCount++;
      availableCount++;
      preferredNames.push(p.name);
      availableNames.push(p.name);
    } else if (status === 'available') {
      availableCount++;
      availableNames.push(p.name);
    } else if (status === 'if_needed') {
      ifNeededCount++;
      ifNeededNames.push(p.name);
    } else {
      unavailableCount++;
      unavailableNames.push(p.name);
    }
  });

  const attendanceRate = total > 0 ? availableCount / total : 0;

  return {
    slotKey: key,
    date,
    timeStr,
    displayTime: formatTimeSlot(timeStr),
    availableCount,
    preferredCount,
    ifNeededCount,
    unavailableCount,
    totalParticipants: total,
    attendanceRate,
    availableNames,
    preferredNames,
    ifNeededNames,
    unavailableNames,
  };
}

// Evaluate multi-slot windows for meeting duration
export function findBestMeetingWindows(poll: Poll): MeetingWindowOption[] {
  const totalParticipants = poll.participants.length;

  const options: MeetingWindowOption[] = [];

  for (const date of poll.dates) {
    const timeSlots = generateDaySlots(poll, date);
    for (const startTime of timeSlots) {
      const window = getMeetingWindow(poll, date, startTime);
      if (!window) continue;
      const windowSlots = window.slotTimes;
      const endTime = window.endTime;
      const displayRange = `${formatTimeSlot(startTime)} – ${formatTimeSlot(endTime)}`;

      // Evaluate each participant across all slots in this window
      const availableAttendees: string[] = [];
      const preferredAttendees: string[] = [];
      const ifNeededAttendees: string[] = [];
      const unavailableAttendees: string[] = [];

      let windowScore = 0;

      poll.participants.forEach((p) => {
        let isAllAvailable = true;
        let isAllPreferred = true;
        let hasIfNeeded = false;
        let isAnyUnavailable = false;

        for (const slotTime of windowSlots) {
          const status = p.availability[slotKey(date, slotTime)];
          if (status === 'preferred') {
            // still good
          } else if (status === 'available') {
            isAllPreferred = false;
          } else if (status === 'if_needed') {
            isAllAvailable = false;
            isAllPreferred = false;
            hasIfNeeded = true;
          } else {
            isAllAvailable = false;
            isAllPreferred = false;
            isAnyUnavailable = true;
          }
        }

        if (isAllPreferred) {
          preferredAttendees.push(p.name);
          availableAttendees.push(p.name);
          windowScore += 3;
        } else if (isAllAvailable) {
          availableAttendees.push(p.name);
          windowScore += 2;
        } else if (hasIfNeeded && !isAnyUnavailable) {
          ifNeededAttendees.push(p.name);
          windowScore += 1;
        } else {
          unavailableAttendees.push(p.name);
        }
      });

      const availableCount = availableAttendees.length;
      const percentage = totalParticipants > 0 ? Math.round((availableCount / totalParticipants) * 100) : 0;
      const allAvailable = totalParticipants > 0 && availableCount === totalParticipants;

      options.push({
        date,
        startTime,
        endTime,
        displayRange,
        availableCount,
        totalParticipants,
        percentage,
        allAvailable,
        score: windowScore,
        availableAttendees,
        preferredAttendees,
        ifNeededAttendees,
        unavailableAttendees,
      });
    }
  }

  // Sort: descending by percentage, then descending by score (preferred votes), then date/time
  options.sort((a, b) => {
    if (b.percentage !== a.percentage) return b.percentage - a.percentage;
    if (b.score !== a.score) return b.score - a.score;
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });

  return options;
}
