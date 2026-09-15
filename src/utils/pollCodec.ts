import type { ParticipantResponse, Poll, SlotStatus } from '../types';

// ─── Availability codec ───
// Availability is stored compactly, and sent compactly to clients that ask for
// it (X-Availability-Format: compact); everything else sees the verbose
// `availability` map. A stored participant carries `slots` instead:
// per answered date, one character per 15-minute index of the day (minutes / 15),
// with trailing unanswered slots trimmed. "2027-01-01": ".a.p" means 00:15
// available and 00:45 preferred. Records written before this format keep their
// verbose `availability` and are read as they are.

const STATUS_CHAR: Record<SlotStatus, string> = {
  available: 'a',
  preferred: 'p',
  if_needed: 'i',
  unavailable: 'u',
};
const CHAR_STATUS = Object.fromEntries(
  Object.entries(STATUS_CHAR).map(([status, char]) => [char, status as SlotStatus])
) as Record<string, SlotStatus>;
const NONE = '.';
const SLOT_MINUTES = 15;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

const KEY_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOTS_RE = new RegExp(`^[${NONE}${Object.values(STATUS_CHAR).join('')}]{1,${SLOTS_PER_DAY}}$`);

type StoredParticipant = Omit<ParticipantResponse, 'availability'> & {
  availability?: Record<string, SlotStatus>;
  slots?: Record<string, string>;
};

/** Per-date slot strings, or null when some entry has no compact form (kept verbose then). */
function encodeAvailability(availability: Record<string, SlotStatus>): Record<string, string> | null {
  const days = new Map<string, string[]>();
  for (const [key, status] of Object.entries(availability)) {
    const match = KEY_RE.exec(key);
    const char = STATUS_CHAR[status];
    if (!match || !char) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    if (minutes % SLOT_MINUTES !== 0 || minutes >= 24 * 60) return null;
    const day = days.get(match[1]) ?? [];
    day[minutes / SLOT_MINUTES] = char;
    days.set(match[1], day);
  }
  const slots: Record<string, string> = {};
  for (const date of [...days.keys()].sort()) {
    slots[date] = Array.from(days.get(date)!, (char) => char ?? NONE).join('');
  }
  return slots;
}

function decodeSlots(slots: unknown): Record<string, SlotStatus> {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
    throw new Error('Participant slots are not an object.');
  }
  const availability: Record<string, SlotStatus> = {};
  for (const [date, day] of Object.entries(slots)) {
    if (!DATE_RE.test(date) || typeof day !== 'string' || !SLOTS_RE.test(day)) {
      throw new Error('Participant slots are malformed.');
    }
    for (let index = 0; index < day.length; index += 1) {
      if (day[index] === NONE) continue;
      const minutes = index * SLOT_MINUTES;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      availability[`${date}T${time}`] = CHAR_STATUS[day[index]];
    }
  }
  return availability;
}

/** The record as stored or sent compactly: participants' availability in compact form where possible. */
export function encodePoll(poll: Poll): unknown {
  return {
    ...poll,
    participants: poll.participants.map((participant): StoredParticipant => {
      const slots = encodeAvailability(participant.availability ?? {});
      if (!slots) return participant;
      const { availability: _availability, ...rest } = participant;
      return { ...rest, slots };
    }),
  };
}

/** Reads a stored record in either format. Anything that is not a poll is corruption and throws. */
export function decodePoll(data: unknown): Poll {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof (data as Poll).id !== 'string') {
    throw new Error('Record is not a poll.');
  }
  const record = data as Poll;
  if (!Array.isArray(record.participants)) return record;
  return {
    ...record,
    participants: (record.participants as unknown[]).map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Participant is not an object.');
      }
      const participant = raw as StoredParticipant;
      if (participant.slots === undefined) return participant as ParticipantResponse;
      const { slots, availability: _availability, ...rest } = participant;
      return { ...rest, availability: decodeSlots(slots) };
    }),
  };
}
