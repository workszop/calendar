export type SlotStatus = 'available' | 'preferred' | 'if_needed' | 'unavailable';

export interface ParticipantResponse {
  id: string;
  name: string;
  email?: string;
  timezone: string;
  updatedAt: string;
  // Key format: "YYYY-MM-DDTHH:mm" (e.g. "2026-09-15T14:30")
  availability: Record<string, SlotStatus>;
}

export interface DayHours {
  startHour: number;
  endHour: number;
}

export interface FinalizedSlot {
  date: string;
  startTime: string;
  endTime: string;
  confirmedBy: string;
  confirmedAt: string;
}

export interface Poll {
  id: string;
  title: string;
  description: string;
  location?: string;
  durationMinutes: number;
  timezone: string;
  dates: string[]; // YYYY-MM-DD
  startHour: number; // 0-24 in half-hour steps, e.g. 9 or 9.5 - default for days without an override
  endHour: number; // 0-24 in half-hour steps, e.g. 17
  // Optional per-date hour windows (YYYY-MM-DD -> hours); overrides startHour/endHour
  dayHours?: Record<string, DayHours>;
  slotInterval: 15 | 30; // grid granularity in minutes
  creatorName: string;
  creatorEmail?: string;
  createdAt: string;
  finalizedSlot?: FinalizedSlot | null;
  participants: ParticipantResponse[];
}

export interface SlotAnalysis {
  slotKey: string;
  date: string;
  timeStr: string;
  displayTime: string;
  availableCount: number;
  preferredCount: number;
  ifNeededCount: number;
  unavailableCount: number;
  totalParticipants: number;
  attendanceRate: number; // 0 to 1
  availableNames: string[];
  preferredNames: string[];
  ifNeededNames: string[];
  unavailableNames: string[];
}

// Shape returned by GET /api/polls - the list view, without participant details
export interface PollSummary
  extends Pick<
    Poll,
    | 'id'
    | 'title'
    | 'description'
    | 'location'
    | 'durationMinutes'
    | 'timezone'
    | 'dates'
    | 'creatorName'
    | 'createdAt'
    | 'finalizedSlot'
  > {
  participantsCount: number;
}
