import express from "express";
import type { DayHours, Poll, ParticipantResponse, PollSummary, SlotStatus } from "../src/types";
import {
  generateDaySlots,
  generateTimeSlots,
  getDayHours,
  getMeetingWindow,
  isHalfHourValue,
  isValidHourWindow,
} from "../src/utils/consensus";
import {
  latestPollDate,
  MAX_BODY_SIZE,
  MAX_DESCRIPTION_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_ID_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_POLL_DATES,
  MAX_POLLS,
  MAX_TIMEZONE_LENGTH,
  MAX_TITLE_LENGTH,
} from "../src/utils/limits";
import { codeMatches, EDIT_HEADER, hashCode, newCode, ORGANIZER_HEADER, readCodeHeader } from "./auth";
import { createFilePollStore, type PollStore } from "./poll-store";
import { isPollExpired, RETENTION_DAYS, withRetention, type Clock } from "./retention";

// ─── Validation primitives ───

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// "HH:mm" in 00:00-23:59, plus 24:00 as an exclusive end-of-day marker.
const TIME_RE = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const SLOT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SLOT_STATUSES: readonly SlotStatus[] = ["available", "preferred", "if_needed", "unavailable"];
const MAX_DURATION_MINUTES = 480;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Minutes since midnight, so "24:00" sorts after "23:30" (string compare would too, but this is explicit). */
function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Absent (undefined/null) or a string. Anything else is a client mistake. */
function isOptionalString(value: unknown): value is string | undefined | null {
  return value === undefined || value === null || typeof value === "string";
}

/** Name of the first field whose string value is longer than its limit, if any. */
function firstTooLong(fields: [name: string, value: unknown, max: number][]): string | undefined {
  const hit = fields.find(([, value, max]) => typeof value === "string" && value.trim().length > max);
  return hit ? `${hit[0]} must be at most ${hit[2]} characters.` : undefined;
}

/** Trimmed value of an optional string field, with a fallback for absent/blank. */
function optionalText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

export type ParsedDayHours =
  | { ok: true; value?: Record<string, DayHours> }
  | { ok: false; error: string };

/**
 * Validates and normalizes per-date hour windows in one pass: malformed input
 * is rejected with a message rather than silently dropped.
 */
export function parseDayHours(input: unknown, dates: string[]): ParsedDayHours {
  if (input === undefined || input === null) return { ok: true };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "dayHours must be an object keyed by date." };
  }

  const allowed = new Set(dates);
  const value: Record<string, DayHours> = {};

  for (const [date, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.has(date)) {
      return { ok: false, error: `dayHours contains ${date}, which is not one of the poll dates.` };
    }
    const v = raw as Partial<DayHours> | null | undefined;
    if (!v || typeof v !== "object") {
      return { ok: false, error: `dayHours for ${date} must be an object with startHour and endHour.` };
    }
    if (!isHalfHourValue(v.startHour) || !isHalfHourValue(v.endHour)) {
      return { ok: false, error: `dayHours for ${date} must use whole or half hours between 0 and 24.` };
    }
    if (!isValidHourWindow(v.startHour, v.endHour)) {
      return { ok: false, error: `dayHours for ${date} must have startHour before endHour.` };
    }
    value[date] = { startHour: v.startHour, endHour: v.endHour };
  }

  return Object.keys(value).length ? { ok: true, value } : { ok: true };
}

export type ParsedProposedSlots =
  | { ok: true; value?: Record<string, string[]> }
  | { ok: false; error: string };

/**
 * Validates an exact per-date proposal: every poll date needs at least one
 * "HH:mm" slot start on the poll's interval grid. Gaps are allowed.
 */
export function parseProposedSlots(input: unknown, dates: string[], slotInterval: number): ParsedProposedSlots {
  if (input === undefined || input === null) return { ok: true };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "proposedSlots must be an object keyed by date." };
  }

  const raw = input as Record<string, unknown>;
  const allowed = new Set(dates);
  const extra = Object.keys(raw).find((date) => !allowed.has(date));
  if (extra) {
    return { ok: false, error: `proposedSlots contains ${extra}, which is not one of the poll dates.` };
  }

  const value: Record<string, string[]> = {};
  for (const date of dates) {
    const times = raw[date];
    if (!Array.isArray(times) || times.length === 0) {
      return { ok: false, error: `proposedSlots for ${date} must list at least one time.` };
    }
    const bad = times.find(
      (t) =>
        typeof t !== "string" ||
        t === "24:00" ||
        !TIME_RE.test(t) ||
        timeToMinutes(t) % slotInterval !== 0
    );
    if (bad !== undefined) {
      return {
        ok: false,
        error: `proposedSlots for ${date} has "${String(bad)}"; use HH:mm starts every ${slotInterval} minutes.`,
      };
    }
    value[date] = [...new Set(times as string[])].sort();
  }
  return { ok: true, value };
}

/** Outer hour window covering every proposed slot, e.g. 09:00 and 14:00 at 30 min -> 9 to 14.5. */
function proposalSpan(slots: Record<string, string[]>, slotInterval: number): { startHour: number; endHour: number } {
  const minutes = Object.values(slots).flat().map(timeToMinutes);
  return {
    startHour: Math.min(...minutes) / 60,
    endHour: (Math.max(...minutes) + slotInterval) / 60,
  };
}

export type ParsedAvailability =
  | { ok: true; value: Record<string, SlotStatus> }
  | { ok: false; error: string };

/** Availability must be a flat map of "YYYY-MM-DDTHH:mm" keys to known statuses. */
export function parseAvailability(input: unknown): ParsedAvailability {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "availability must be an object keyed by slot." };
  }

  const value: Record<string, SlotStatus> = {};
  for (const [key, status] of Object.entries(input as Record<string, unknown>)) {
    if (!SLOT_KEY_RE.test(key)) {
      return { ok: false, error: `availability key "${key}" must look like YYYY-MM-DDTHH:mm.` };
    }
    if (typeof status !== "string" || !SLOT_STATUSES.includes(status as SlotStatus)) {
      return { ok: false, error: `availability["${key}"] must be one of ${SLOT_STATUSES.join(", ")}.` };
    }
    value[key] = status as SlotStatus;
  }
  return { ok: true, value };
}

// ─── Public views ───

/** Largest number of ids one "my polls" list request may ask for. */
const MAX_LIST_IDS = 50;

/**
 * The poll as clients may see it: code hashes are always removed, and emails
 * only reach the organizer.
 */
export function toPublicPoll(poll: Poll, isOrganizer: boolean): Poll {
  const { organizerCodeHash: _organizerCodeHash, creatorEmail, participants, ...rest } = poll;
  return {
    ...rest,
    ...(isOrganizer && creatorEmail ? { creatorEmail } : {}),
    participants: participants.map(({ editCodeHash: _editCodeHash, email, ...participant }) => ({
      ...participant,
      ...(isOrganizer && email ? { email } : {}),
    })),
  };
}

function toSummary(poll: Poll): PollSummary {
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    location: poll.location,
    durationMinutes: poll.durationMinutes,
    timezone: poll.timezone,
    dates: poll.dates,
    creatorName: poll.creatorName,
    createdAt: poll.createdAt,
    finalizedSlot: poll.finalizedSlot,
    participantsCount: poll.participants.length,
  };
}

const ORGANIZER_ONLY = "Only the organizer can do this. Enter the organizer code to unlock it.";

export interface ApiOptions {
  /** Current time for poll retention; tests pin it so fixture dates never expire. */
  clock?: Clock;
}

/** Builds the JSON API. A string keeps the original file-backed API; a PollStore enables cloud storage. */
export function createApi(source: string | PollStore, options: ApiOptions = {}) {
  const app = express();
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Mutations with a body must be JSON. Browsers cannot send that cross-site
  // without a CORS preflight, which this API never grants.
  app.use("/api", (req, res, next) => {
    // Browsers send "Content-Length: 0" on a bodiless POST (e.g. reset); that has nothing to parse.
    const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    if (req.method !== "GET" && hasBody && !req.is("application/json")) {
      res.status(415).json({ error: "Requests must use Content-Type: application/json." });
      return;
    }
    next();
  });
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  // ─── Storage ───
  // Polls past their retention window are hidden from reads and dropped on writes.
  const clock = options.clock ?? (() => new Date());
  const pollStore = withRetention(
    typeof source === "string" ? createFilePollStore(source) : source,
    clock
  );

  /** Wraps an async handler so rejections still produce a JSON 500. */
  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    (req, res, next) => {
      fn(req, res).catch(next);
    };

  // ─── Routes: read ───

  // Health check
  app.get("/api/health", wrap(async (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  }));

  // Summaries for the polls a browser knows about (?ids=a,b,c). There is no
  // "list everything": a poll is only reachable by someone holding its link.
  app.get("/api/polls", wrap(async (req, res) => {
    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
    if (ids.length > MAX_LIST_IDS) {
      res.status(400).json({ error: `Ask for at most ${MAX_LIST_IDS} polls at once.` });
      return;
    }
    if (ids.length === 0) {
      res.json([]);
      return;
    }
    const wanted = new Set(ids);
    const polls = await pollStore.load();
    res.json(polls.filter((poll) => wanted.has(poll.id)).map(toSummary));
  }));

  // Get single poll
  app.get("/api/polls/:id", wrap(async (req, res) => {
    const polls = await pollStore.load();
    const poll = polls.find((p) => p.id === req.params.id);
    if (!poll) {
      res.status(404).json({ error: "Poll not found" });
      return;
    }
    res.json(toPublicPoll(poll, codeMatches(readCodeHeader(req, ORGANIZER_HEADER), poll.organizerCodeHash)));
  }));

  // Whether the presented organizer code unlocks this poll.
  app.get("/api/polls/:id/access", wrap(async (req, res) => {
    const polls = await pollStore.load();
    const poll = polls.find((p) => p.id === req.params.id);
    if (!poll) {
      res.status(404).json({ error: "Poll not found" });
      return;
    }
    res.json({ organizer: codeMatches(readCodeHeader(req, ORGANIZER_HEADER), poll.organizerCodeHash) });
  }));

  // ─── Routes: create ───

  app.post(
    "/api/polls",
    wrap(async (req, res) => {
      const body = req.body ?? {};

      if (typeof body.title !== "string" || !body.title.trim()) {
        res.status(400).json({ error: "Title is required." });
        return;
      }
      if (!Array.isArray(body.dates) || !body.dates.length) {
        res.status(400).json({ error: "At least one date is required." });
        return;
      }
      for (const field of ["description", "location", "creatorName", "creatorEmail", "timezone"] as const) {
        if (!isOptionalString(body[field])) {
          res.status(400).json({ error: `${field} must be a string.` });
          return;
        }
      }

      const createTooLong = firstTooLong([
        ["title", body.title, MAX_TITLE_LENGTH],
        ["description", body.description, MAX_DESCRIPTION_LENGTH],
        ["location", body.location, MAX_LOCATION_LENGTH],
        ["creatorName", body.creatorName, MAX_NAME_LENGTH],
        ["creatorEmail", body.creatorEmail, MAX_EMAIL_LENGTH],
        ["timezone", body.timezone, MAX_TIMEZONE_LENGTH],
      ]);
      if (createTooLong) {
        res.status(400).json({ error: createTooLong });
        return;
      }

      const rawDates = body.dates as unknown[];
      const badDate = rawDates.find((d) => !isCalendarDate(d));
      if (badDate !== undefined) {
        res.status(400).json({ error: `Invalid date "${String(badDate)}" - expected YYYY-MM-DD.` });
        return;
      }
      const dates = [...new Set(rawDates as string[])].sort();
      if (dates.length > MAX_POLL_DATES) {
        res.status(400).json({ error: `A poll can have at most ${MAX_POLL_DATES} dates.` });
        return;
      }
      const tooFar = dates.find((d) => d > latestPollDate(clock()));
      if (tooFar) {
        res.status(400).json({ error: `${tooFar} is too far ahead; choose dates within the next year.` });
        return;
      }

      const slotInterval = body.slotInterval ?? 30;
      if (slotInterval !== 15 && slotInterval !== 30) {
        res.status(400).json({ error: "slotInterval must be 15 or 30 minutes." });
        return;
      }

      const hasDuration = body.durationMinutes !== undefined && body.durationMinutes !== null;
      if (
        hasDuration &&
        (typeof body.durationMinutes !== "number" ||
          !Number.isInteger(body.durationMinutes) ||
          body.durationMinutes <= 0 ||
          body.durationMinutes > MAX_DURATION_MINUTES)
      ) {
        res
          .status(400)
          .json({ error: `durationMinutes must be a positive integer up to ${MAX_DURATION_MINUTES}.` });
        return;
      }

      const hasStart = body.startHour !== undefined && body.startHour !== null;
      const hasEnd = body.endHour !== undefined && body.endHour !== null;
      if (hasStart && !isHalfHourValue(body.startHour)) {
        res.status(400).json({ error: "startHour must be a whole or half hour between 0 and 24." });
        return;
      }
      if (hasEnd && !isHalfHourValue(body.endHour)) {
        res.status(400).json({ error: "endHour must be a whole or half hour between 0 and 24." });
        return;
      }
      let startHour = hasStart ? (body.startHour as number) : 9;
      let endHour = hasEnd ? (body.endHour as number) : 17;
      if (startHour >= endHour) {
        res.status(400).json({ error: "startHour must be before endHour." });
        return;
      }

      const dayHours = parseDayHours(body.dayHours, dates);
      if (!dayHours.ok) {
        res.status(400).json({ error: dayHours.error });
        return;
      }

      const proposedSlots = parseProposedSlots(body.proposedSlots, dates, slotInterval);
      if (!proposedSlots.ok) {
        res.status(400).json({ error: proposedSlots.error });
        return;
      }
      if (proposedSlots.value) {
        if (dayHours.value) {
          res.status(400).json({ error: "Send either dayHours or proposedSlots, not both." });
          return;
        }
        // Keep the poll-wide window equal to the proposal's outer span.
        ({ startHour, endHour } = proposalSpan(proposedSlots.value, slotInterval));
      }

      const id = "poll_" + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
      // Returned exactly once; only its hash is stored.
      const organizerCode = newCode();
      const newPoll: Poll = {
        id,
        title: body.title.trim(),
        description: optionalText(body.description),
        location: optionalText(body.location, "Online Meeting"),
        durationMinutes: hasDuration ? (body.durationMinutes as number) : 30,
        timezone: optionalText(body.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        dates,
        startHour,
        endHour,
        dayHours: dayHours.value,
        proposedSlots: proposedSlots.value,
        slotInterval,
        creatorName: optionalText(body.creatorName, "Organizer"),
        creatorEmail: optionalText(body.creatorEmail),
        createdAt: new Date().toISOString(),
        finalizedSlot: null,
        participants: [],
        organizerCodeHash: hashCode(organizerCode),
      };

      // A poll that would be deleted immediately is almost certainly a mistake.
      if (isPollExpired(newPoll, clock())) {
        res.status(400).json({
          error: `The last date is more than ${RETENTION_DAYS} days in the past; such polls are deleted automatically.`,
        });
        return;
      }

      let storeFull = false;
      await pollStore.mutate((polls) => {
        storeFull = false;
        // A CAS write may have committed before its response was lost. If
        // the store replays this closure, the allocated id makes the create
        // idempotent instead of inserting the same poll twice.
        const existing = polls.find((poll) => poll.id === newPoll.id);
        if (existing) return existing;
        if (polls.length >= MAX_POLLS) {
          storeFull = true;
          return null;
        }
        polls.unshift(newPoll);
        return newPoll;
      });
      if (storeFull) {
        res.status(503).json({ error: "The app has reached its poll limit. Please try again later." });
        return;
      }
      res.status(201).json({ ...toPublicPoll(newPoll, true), organizerCode });
    })
  );

  // ─── Routes: extend ───

  // Adds candidate dates to an existing poll. Existing dates and answers are
  // untouched. A poll stays in hour-window form while the new days use its
  // default window; otherwise it switches to exact per-date slots.
  app.post(
    "/api/polls/:id/dates",
    wrap(async (req, res) => {
      const body = req.body ?? {};
      if (!Array.isArray(body.dates) || body.dates.length === 0) {
        res.status(400).json({ error: "Choose at least one date to add." });
        return;
      }
      const badDate = (body.dates as unknown[]).find((d) => !isCalendarDate(d));
      if (badDate !== undefined) {
        res.status(400).json({ error: `Invalid date "${String(badDate)}" - expected YYYY-MM-DD.` });
        return;
      }
      const newDates = [...new Set(body.dates as string[])].sort();
      // One day of slack: the browser's "today" may still be yesterday in UTC.
      const earliest = new Date(clock());
      earliest.setUTCDate(earliest.getUTCDate() - 1);
      const pastDate = newDates.find((d) => d < earliest.toISOString().slice(0, 10));
      if (pastDate) {
        res.status(400).json({ error: `${pastDate} is in the past.` });
        return;
      }
      const farDate = newDates.find((d) => d > latestPollDate(clock()));
      if (farDate) {
        res.status(400).json({ error: `${farDate} is too far ahead; choose dates within the next year.` });
        return;
      }

      let failure: { status: number; error: string } | null = null;
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);

      const poll = await pollStore.mutate((polls) => {
        failure = null;
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
        const reject = (status: number, error: string) => {
          failure = { status, error };
          return null;
        };

        if (!codeMatches(organizerCode, found.organizerCodeHash)) return reject(403, ORGANIZER_ONLY);
        if (found.finalizedSlot) {
          return reject(409, "Re-open voting before adding dates.");
        }
        const duplicate = newDates.find((d) => found.dates.includes(d));
        if (duplicate) return reject(400, `${duplicate} is already one of the poll dates.`);
        if (found.dates.length + newDates.length > MAX_POLL_DATES) {
          return reject(400, `A poll can have at most ${MAX_POLL_DATES} dates.`);
        }
        const parsed = parseProposedSlots(body.proposedSlots, newDates, found.slotInterval);
        if (!parsed.ok) return reject(400, parsed.error);
        if (!parsed.value) return reject(400, "proposedSlots is required: list the times for each new date.");
        const added = parsed.value;

        const defaultSlots = generateTimeSlots(found.startHour, found.endHour, found.slotInterval).join();
        const fitsWindow = newDates.every((d) => added[d].join() === defaultSlots);

        if (found.proposedSlots || !fitsWindow) {
          // Freeze the existing dates' slots exactly as participants saw them.
          const existing = found.proposedSlots
            ? found.proposedSlots
            : Object.fromEntries(found.dates.map((d) => [d, generateDaySlots(found, d)]));
          found.proposedSlots = { ...existing, ...added };
          found.dayHours = undefined;
          Object.assign(found, proposalSpan(found.proposedSlots, found.slotInterval));
        }
        found.dates = [...found.dates, ...newDates].sort();
        return found;
      });

      if (failure) {
        const { status, error } = failure as { status: number; error: string };
        res.status(status).json({ error });
        return;
      }
      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(toPublicPoll(poll, true));
    })
  );

  // ─── Routes: delete ───

  app.delete(
    "/api/polls/:id",
    wrap(async (req, res) => {
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);
      let forbidden = false;
      const deleted = await pollStore.mutate((polls) => {
        forbidden = false;
        const index = polls.findIndex((poll) => poll.id === req.params.id);
        // Nothing to remove: 404 without a write.
        if (index === -1) return null;
        if (!codeMatches(organizerCode, polls[index].organizerCodeHash)) {
          forbidden = true;
          return null;
        }
        polls.splice(index, 1);
        return { id: req.params.id };
      });

      if (forbidden) {
        res.status(403).json({ error: ORGANIZER_ONLY });
        return;
      }
      if (!deleted) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(deleted);
    })
  );

  // ─── Routes: participant responses ───

  app.post(
    "/api/polls/:id/respond",
    wrap(async (req, res) => {
      const { name, email, timezone, availability, participantId } = req.body ?? {};
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "Name is required." });
        return;
      }
      for (const [field, value] of [
        ["email", email],
        ["timezone", timezone],
      ] as const) {
        if (!isOptionalString(value)) {
          res.status(400).json({ error: `${field} must be a string.` });
          return;
        }
      }
      if (participantId !== undefined && participantId !== null && typeof participantId !== "string") {
        res.status(400).json({ error: "participantId must be a string." });
        return;
      }
      const respondTooLong = firstTooLong([
        ["name", name, MAX_NAME_LENGTH],
        ["email", email, MAX_EMAIL_LENGTH],
        ["timezone", timezone, MAX_TIMEZONE_LENGTH],
        ["participantId", participantId, MAX_ID_LENGTH],
      ]);
      if (respondTooLong) {
        res.status(400).json({ error: respondTooLong });
        return;
      }
      const parsedAvailability = parseAvailability(availability);
      if (!parsedAvailability.ok) {
        res.status(400).json({ error: parsedAvailability.error });
        return;
      }

      // Set when the poll exists but the supplied participantId does not, so
      // the 404 can say which of the two was missing.
      let unknownParticipant = false;
      let invalidSlot: string | undefined;
      let pollFull = false;
      let forbidden = false;
      let isOrganizer = false;
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);
      const editCode = readCodeHeader(req, EDIT_HEADER);
      // Only a brand-new response gets a code, and it is returned exactly once.
      let issuedEditCode: string | undefined;

      const outcome = await pollStore.mutate((polls) => {
        // Blob CAS may replay this closure. Never let an earlier attempt's
        // diagnostic flags leak into the final response.
        unknownParticipant = false;
        invalidSlot = undefined;
        pollFull = false;
        forbidden = false;
        issuedEditCode = undefined;
        const poll = polls.find((candidate) => candidate.id === req.params.id);
        if (!poll) return null;
        isOrganizer = codeMatches(organizerCode, poll.organizerCodeHash);
        const proposed = new Set(poll.dates.flatMap((date) =>
          generateDaySlots(poll, date).map((time) => `${date}T${time}`)
        ));
        invalidSlot = Object.keys(parsedAvailability.value).find((key) => !proposed.has(key));
        if (invalidSlot) return null;

        // Updating needs the response's edit code (or the organizer code). There
        // is no name matching: without an id and code, a save is a new response.
        let existingIdx = -1;
        if (participantId) {
          existingIdx = poll.participants.findIndex((p) => p.id === participantId);
          if (existingIdx === -1) {
            unknownParticipant = true;
            return null;
          }
          if (!isOrganizer && !codeMatches(editCode, poll.participants[existingIdx].editCodeHash)) {
            forbidden = true;
            return null;
          }
        }

        if (existingIdx === -1 && poll.participants.length >= MAX_PARTICIPANTS) {
          pollFull = true;
          return null;
        }

        // Never trust a client-supplied id for a brand-new record.
        const id =
          existingIdx >= 0
            ? poll.participants[existingIdx].id
            : "part_" + Math.random().toString(36).substring(2, 9);

        if (existingIdx === -1) issuedEditCode = newCode();
        const responseEntry: ParticipantResponse = {
          id,
          name: name.trim(),
          email: optionalText(email),
          timezone: optionalText(timezone) || poll.timezone,
          updatedAt: new Date().toISOString(),
          availability: parsedAvailability.value,
          editCodeHash: issuedEditCode
            ? hashCode(issuedEditCode)
            : poll.participants[existingIdx].editCodeHash,
        };

        if (existingIdx >= 0) poll.participants[existingIdx] = responseEntry;
        else poll.participants.push(responseEntry);

        return { poll, participant: responseEntry };
      });

      if (forbidden) {
        res.status(403).json({ error: "This response can only be changed from the browser that saved it." });
        return;
      }
      if (pollFull) {
        res.status(409).json({ error: `This poll has reached its limit of ${MAX_PARTICIPANTS} responses.` });
        return;
      }
      if (invalidSlot) {
        res.status(400).json({ error: `availability slot ${invalidSlot} is outside the poll's proposed slots.` });
        return;
      }
      if (!outcome) {
        res
          .status(404)
          .json({ error: unknownParticipant ? "Participant not found" : "Poll not found" });
        return;
      }
      const publicPoll = toPublicPoll(outcome.poll, isOrganizer);
      res.json({
        poll: publicPoll,
        participant: publicPoll.participants.find((p) => p.id === outcome.participant.id),
        ...(issuedEditCode ? { editCode: issuedEditCode } : {}),
      });
    })
  );

  app.delete(
    "/api/polls/:id/respond/:participantId",
    wrap(async (req, res) => {
      let unknownParticipant = false;
      let forbidden = false;
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);

      const poll = await pollStore.mutate((polls) => {
        unknownParticipant = false;
        forbidden = false;
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
        if (!codeMatches(organizerCode, found.organizerCodeHash)) {
          forbidden = true;
          return null;
        }
        const remaining = found.participants.filter((p) => p.id !== req.params.participantId);
        // Nothing removed means the id was never here: 404 without a write.
        if (remaining.length === found.participants.length) {
          unknownParticipant = true;
          return null;
        }
        found.participants = remaining;
        return found;
      });

      if (forbidden) {
        res.status(403).json({ error: ORGANIZER_ONLY });
        return;
      }
      if (!poll) {
        res
          .status(404)
          .json({ error: unknownParticipant ? "Participant not found" : "Poll not found" });
        return;
      }
      res.json(toPublicPoll(poll, true));
    })
  );

  // ─── Routes: finalize and reset ───

  app.post(
    "/api/polls/:id/finalize",
    wrap(async (req, res) => {
      const { date, startTime, endTime, confirmedBy } = req.body ?? {};

      // Validation that needs the poll runs inside the mutation, so there is
      // exactly one lookup and one 404 path.
      let failure: { status: number; error: string } | null = null;
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);

      const poll = await pollStore.mutate((polls) => {
        // Validation may run again after a CAS conflict.
        failure = null;
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
        if (!codeMatches(organizerCode, found.organizerCodeHash)) {
          failure = { status: 403, error: ORGANIZER_ONLY };
          return null;
        }
        const reject = (error: string) => {
          failure = { status: 400, error };
          return null;
        };

        if (!isCalendarDate(date)) {
          return reject("date must be a YYYY-MM-DD string.");
        }
        if (!found.dates.includes(date)) {
          return reject(`date ${date} is not one of the poll dates.`);
        }
        if (typeof startTime !== "string" || !TIME_RE.test(startTime)) {
          return reject("startTime must be an HH:mm string.");
        }
        if (typeof endTime !== "string" || !TIME_RE.test(endTime)) {
          return reject("endTime must be an HH:mm string.");
        }
        if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
          return reject("startTime must be before endTime.");
        }
        const hours = getDayHours(found, date);
        if (timeToMinutes(startTime) < hours.startHour * 60 || timeToMinutes(endTime) > hours.endHour * 60) {
          return reject("Meeting must fit within the proposed hours for this date.");
        }
        if (!isOptionalString(confirmedBy)) {
          return reject("confirmedBy must be a string.");
        }
        const confirmedTooLong = firstTooLong([["confirmedBy", confirmedBy, MAX_NAME_LENGTH]]);
        if (confirmedTooLong) return reject(confirmedTooLong);
        const meetingWindow = getMeetingWindow(found, date, startTime);
        if (!meetingWindow || meetingWindow.endTime !== endTime) {
          return reject("Choose a proposed start time and the poll's exact meeting duration.");
        }
        if (found.finalizedSlot) {
          failure = { status: 409, error: "Re-open voting before choosing another meeting time." };
          return null;
        }

        found.finalizedSlot = {
          date,
          startTime,
          endTime,
          confirmedBy: optionalText(confirmedBy) || found.creatorName || "Organizer",
          confirmedAt: new Date().toISOString(),
        };
        return found;
      });

      if (failure) {
        const { status, error } = failure as { status: number; error: string };
        res.status(status).json({ error });
        return;
      }
      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(toPublicPoll(poll, true));
    })
  );

  app.post(
    "/api/polls/:id/reset",
    wrap(async (req, res) => {
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);
      let forbidden = false;
      const poll = await pollStore.mutate((polls) => {
        forbidden = false;
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
        if (!codeMatches(organizerCode, found.organizerCodeHash)) {
          forbidden = true;
          return null;
        }
        found.finalizedSlot = null;
        return found;
      });

      if (forbidden) {
        res.status(403).json({ error: ORGANIZER_ONLY });
        return;
      }
      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(toPublicPoll(poll, true));
    })
  );

  // ─── Errors ───
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  // JSON error handler - keeps API failures machine-readable
  app.use("/api", (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    // Body-parser and friends tag their failures with a status (400, 413, ...).
    const tagged = err as { status?: unknown; statusCode?: unknown; message?: unknown };
    const raw = tagged?.status ?? tagged?.statusCode;
    const status = typeof raw === "number" ? raw : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const message = typeof tagged.message === "string" && tagged.message ? tagged.message : "Bad request";
      res.status(status).json({ error: message });
      return;
    }
    console.error("API error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
