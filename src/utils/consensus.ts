import type { DayHours, Poll, SlotAnalysis, SlotStatus } from '../types';
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

/** The poll fields that decide which slots exist and how long a meeting is. */
export type PollSlotConfig = Pick<
  Poll,
  'durationMinutes' | 'slotInterval' | 'startHour' | 'endHour' | 'dayHours' | 'proposedSlots'
>;

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

// Explicit slots proposed for one date, or null when the poll uses hour windows
function getProposedSlots(poll: PollSlotConfig, date: string): string[] | null {
  const slots = poll.proposedSlots?.[date];
  return slots && slots.length ? [...slots].sort() : null;
}

// Outer hour window for one date: the span of its proposed slots, its
// override, or the poll-wide default
export function getDayHours(poll: PollSlotConfig, date: string): DayHours {
  const proposed = getProposedSlots(poll, date);
  if (proposed) {
    return {
      startHour: timeToMinutes(proposed[0]) / 60,
      endHour: (timeToMinutes(proposed[proposed.length - 1]) + poll.slotInterval) / 60,
    };
  }
  const override = poll.dayHours?.[date];
  if (override && isValidHourWindow(override.startHour, override.endHour)) return override;
  return { startHour: poll.startHour, endHour: poll.endHour };
}

// Slots suggested for one date
export function generateDaySlots(poll: PollSlotConfig, date: string): string[] {
  const proposed = getProposedSlots(poll, date);
  if (proposed) return proposed;
  const { startHour, endHour } = getDayHours(poll, date);
  return generateTimeSlots(startHour, endHour, poll.slotInterval);
}

// Union of every date's slots - the grid rows
export function generateAllTimeSlots(poll: Poll): string[] {
  const set = new Set<string>();
  poll.dates.forEach((d) => generateDaySlots(poll, d).forEach((t) => set.add(t)));
  return [...set].sort();
}

// "HH:mm" -> minutes after midnight ("09:30" -> 570)
export function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Resolve the atomic grid slots covered by one exact-duration meeting.
 * Returns null when the start is not a proposed slot or the meeting would
 * cross that date's availability window.
 */
export function getMeetingWindow(poll: PollSlotConfig, date: string, startTime: string): MeetingWindow | null {
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
  // A meeting must not jump over a gap in the proposed slots.
  const contiguous = slotTimes.every(
    (time, i) => i === 0 || timeToMinutes(time) === timeToMinutes(slotTimes[i - 1]) + interval
  );
  if (!contiguous) return null;

  return {
    startTime,
    endTime: addMinutesToTime(startTime, duration),
    slotTimes,
  };
}

/**
 * First of these dates on which no run of back-to-back proposed slots covers
 * the meeting duration, or undefined when every date fits. A date fits when
 * getMeetingWindow accepts at least one of its slot starts, the same rule the
 * server applies on create and add-dates.
 */
export function findDateWithoutMeetingFit(poll: PollSlotConfig, dates: string[]): string | undefined {
  return dates.find(
    (date) => !generateDaySlots(poll, date).some((startTime) => getMeetingWindow(poll, date, startTime))
  );
}

// ─── Attendance ───

/**
 * How one participant can attend every atomic slot of a window: preferred only
 * when every slot is preferred, available when every slot is preferred or
 * available, if needed when no slot is busy or unanswered, otherwise
 * unavailable. An empty window is unavailable.
 */
export function getWindowAttendance(
  availability: Record<string, SlotStatus>,
  date: string,
  slotTimes: string[]
): SlotStatus {
  if (!slotTimes.length) return 'unavailable';
  let attendance: SlotStatus = 'preferred';
  for (const time of slotTimes) {
    const status = availability[slotKey(date, time)];
    if (status === 'preferred') continue;
    if (status === 'available') {
      if (attendance === 'preferred') attendance = 'available';
    } else if (status === 'if_needed') {
      attendance = 'if_needed';
    } else {
      return 'unavailable';
    }
  }
  return attendance;
}

export interface WindowAttendanceSummary {
  /** Everyone who can attend the whole window, preferred included. */
  availableNames: string[];
  preferredNames: string[];
  ifNeededNames: string[];
  unavailableNames: string[];
  /** 3 per preferred, 2 per available, 1 per if-needed participant. */
  score: number;
}

const ATTENDANCE_SCORE: Record<SlotStatus, number> = {
  preferred: 3,
  available: 2,
  if_needed: 1,
  unavailable: 0,
};

/** Group participants by whole-window attendance, in participant order. */
export function summarizeWindowAttendance(
  poll: Pick<Poll, 'participants'>,
  date: string,
  slotTimes: string[]
): WindowAttendanceSummary {
  const summary: WindowAttendanceSummary = {
    availableNames: [],
    preferredNames: [],
    ifNeededNames: [],
    unavailableNames: [],
    score: 0,
  };
  poll.participants.forEach((participant) => {
    const attendance = getWindowAttendance(participant.availability, date, slotTimes);
    summary.score += ATTENDANCE_SCORE[attendance];
    if (attendance === 'preferred') {
      summary.preferredNames.push(participant.name);
      summary.availableNames.push(participant.name);
    } else if (attendance === 'available') {
      summary.availableNames.push(participant.name);
    } else if (attendance === 'if_needed') {
      summary.ifNeededNames.push(participant.name);
    } else {
      summary.unavailableNames.push(participant.name);
    }
  });
  return summary;
}

// Analyze single atomic slot
export function analyzeSlot(poll: Poll, date: string, timeStr: string): SlotAnalysis {
  return analyzeWindow(poll, date, timeStr, [timeStr]);
}

/**
 * Analyze a display cell covering several atomic slots, reported under its
 * first slot. A participant counts only for what they can attend throughout.
 */
export function analyzeWindow(poll: Poll, date: string, timeStr: string, slotTimes: string[]): SlotAnalysis {
  const total = poll.participants.length;
  const { availableNames, preferredNames, ifNeededNames, unavailableNames } = summarizeWindowAttendance(
    poll,
    date,
    slotTimes
  );

  return {
    slotKey: slotKey(date, timeStr),
    date,
    timeStr,
    displayTime: formatTimeSlot(timeStr),
    availableCount: availableNames.length,
    preferredCount: preferredNames.length,
    ifNeededCount: ifNeededNames.length,
    unavailableCount: unavailableNames.length,
    totalParticipants: total,
    attendanceRate: total > 0 ? availableNames.length / total : 0,
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
      const attendance = summarizeWindowAttendance(poll, date, windowSlots);
      const availableAttendees = attendance.availableNames;

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
        score: attendance.score,
        availableAttendees,
        preferredAttendees: attendance.preferredNames,
        ifNeededAttendees: attendance.ifNeededNames,
        unavailableAttendees: attendance.unavailableNames,
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
