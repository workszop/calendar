import express from "express";
import type { DayHours, Poll, ParticipantResponse, SlotStatus } from "../src/types";
import {
  generateDaySlots,
  generateTimeSlots,
  getDayHours,
  getMeetingWindow,
  isHalfHourValue,
  findDateWithoutMeetingFit,
  isValidHourWindow,
  timeToMinutes,
} from "../src/utils/consensus";
import { encodePoll } from "../src/utils/pollCodec";
import { toPollSummary } from "../src/utils/pollSummary";
import {
  earliestPollDate,
  latestPollDate,
  MAX_AVAILABILITY_ENTRIES,
  MAX_BODY_SIZE,
  MAX_DESCRIPTION_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_ID_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_POLL_DATES,
  MAX_TIMEZONE_LENGTH,
  MAX_TITLE_LENGTH,
} from "../src/utils/limits";
import {
  CLIENT_CODE_RE,
  codeMatches,
  EDIT_HEADER,
  hashCode,
  newCode,
  newId,
  ORGANIZER_HEADER,
  readCodeHeader,
} from "./auth";
import { createFilePollStore, PollStoreConflictError, PollUnreadableError, type PollStore } from "./poll-store";
import {
  createRateLimiter,
  expressClientIp,
  type ClientIp,
  type RateLimitConfig,
  type RateLimiter,
} from "./rate-limit";
import { withRetention, type Clock } from "./retention";

// ─── Validation primitives ───

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// "HH:mm" in 00:00-23:59, plus 24:00 as an exclusive end-of-day marker.
const TIME_RE = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const SLOT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SLOT_STATUSES: readonly SlotStatus[] = ["available", "preferred", "if_needed", "unavailable"];
const MAX_DURATION_MINUTES = 480;
// Shaped like an IANA zone name, e.g. "Europe/Warsaw" or "Etc/GMT+1". The
// server never converts times, so a name its own zone data does not know yet
// (a browser newer than this runtime) is stored as given rather than refused
// with nothing the organizer could change.
const TIMEZONE_NAME_RE = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * A refusal decided inside a store update closure. Throwing it aborts the
 * write; the error handler turns it into the JSON answer. A closure may run
 * again after a storage conflict, so a thrown refusal can never leak from an
 * earlier attempt the way a captured flag could.
 */
class RequestError extends Error {
  readonly status: number;
  readonly statusCode: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.statusCode = status;
  }
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

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_AVAILABILITY_ENTRIES) {
    return { ok: false, error: `availability may list at most ${MAX_AVAILABILITY_ENTRIES} slots.` };
  }
  const value: Record<string, SlotStatus> = {};
  for (const [key, status] of entries) {
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

/** Header a client sends to receive availability in the compact storage form. */
const FORMAT_HEADER = "x-availability-format";

/**
 * The public poll in the format the client asked for. Compact availability keeps
 * even a fully answered maximum-size poll far below the function response limit.
 */
function pollForClient(req: express.Request, poll: Poll, isOrganizer: boolean): unknown {
  const publicPoll = toPublicPoll(poll, isOrganizer);
  return req.headers[FORMAT_HEADER] === "compact" ? encodePoll(publicPoll) : publicPoll;
}

const ORGANIZER_ONLY = "Only the organizer can do this. Enter the organizer code to unlock it.";
const VOTING_CLOSED = "Voting is closed. The organizer must re-open voting before answers can change.";
/** Fresh ids to try if a generated poll id is somehow already taken. */
const CREATE_ID_ATTEMPTS = 3;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ApiOptions {
  /** Current time for poll retention; tests pin it so fixture dates never expire. */
  clock?: Clock;
  /**
   * Per-IP limits on mutating routes. Pass limits to override the defaults, a
   * shared RateLimiter so limits outlive one app instance, or `false` to disable.
   */
  rateLimit?: RateLimitConfig | RateLimiter | false;
  /** How to identify a client for rate limiting. Defaults to Express's `req.ip`. */
  clientIp?: ClientIp;
}

function isRateLimiter(value: ApiOptions["rateLimit"]): value is RateLimiter {
  return typeof value === "object" && value !== null && typeof (value as RateLimiter).middleware === "function";
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

  // ─── Rate limits ───
  // Registered ahead of body parsing and the routes; reads are never limited here.
  if (options.rateLimit !== false) {
    const limiter = isRateLimiter(options.rateLimit) ? options.rateLimit : createRateLimiter(options.rateLimit);
    const clientIp = options.clientIp ?? expressClientIp;
    const limitCreate = limiter.middleware("create", clientIp);
    const limitWrite = limiter.middleware("write", clientIp);
    app.post("/api/polls", limitCreate);
    app.use("/api/polls/:id", (req, res, next) => (SAFE_METHODS.has(req.method) ? next() : limitWrite(req, res, next)));
  }

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
    res.json((await pollStore.getMany(ids)).map(toPollSummary));
  }));

  // Get single poll
  app.get("/api/polls/:id", wrap(async (req, res) => {
    const poll = await pollStore.get(req.params.id);
    if (!poll) {
      res.status(404).json({ error: "Poll not found" });
      return;
    }
    res.json(pollForClient(req, poll, codeMatches(readCodeHeader(req, ORGANIZER_HEADER), poll.organizerCodeHash)));
  }));

  // Whether the presented organizer code unlocks this poll.
  app.get("/api/polls/:id/access", wrap(async (req, res) => {
    const poll = await pollStore.get(req.params.id);
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

      const timezone = optionalText(body.timezone);
      if (timezone && !TIMEZONE_NAME_RE.test(timezone)) {
        res.status(400).json({ error: "timezone must be a valid IANA time zone, e.g. Europe/Warsaw." });
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
      const pastDate = dates.find((d) => d < earliestPollDate(clock()));
      if (pastDate) {
        res.status(400).json({ error: `${pastDate} is in the past.` });
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

      // Returned exactly once; only its hash is stored.
      const organizerCode = newCode();
      const newPoll: Poll = {
        id: newId("poll"),
        title: body.title.trim(),
        description: optionalText(body.description),
        location: optionalText(body.location, "Online Meeting"),
        durationMinutes: hasDuration ? (body.durationMinutes as number) : 30,
        timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
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

      const unfit = findDateWithoutMeetingFit(newPoll, dates);
      if (unfit) {
        res.status(400).json({ error: `${unfit} has no ${newPoll.durationMinutes}-minute run of proposed times.` });
        return;
      }

      // The store treats a replay of the very same poll as success, so a lost
      // write response never inserts it twice. A taken id gets a fresh one.
      let stored = await pollStore.create(newPoll);
      for (let attempt = 1; !stored && attempt < CREATE_ID_ATTEMPTS; attempt += 1) {
        newPoll.id = newId("poll");
        stored = await pollStore.create(newPoll);
      }
      if (!stored) throw new PollStoreConflictError();
      res.status(201).json({ ...(pollForClient(req, newPoll, true) as object), organizerCode });
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
      const pastDate = newDates.find((d) => d < earliestPollDate(clock()));
      if (pastDate) {
        res.status(400).json({ error: `${pastDate} is in the past.` });
        return;
      }
      const farDate = newDates.find((d) => d > latestPollDate(clock()));
      if (farDate) {
        res.status(400).json({ error: `${farDate} is too far ahead; choose dates within the next year.` });
        return;
      }

      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);

      const poll = await pollStore.update(req.params.id, (found) => {
        if (!codeMatches(organizerCode, found.organizerCodeHash)) throw new RequestError(403, ORGANIZER_ONLY);
        if (found.finalizedSlot) throw new RequestError(409, "Re-open voting before adding dates.");
        const parsed = parseProposedSlots(body.proposedSlots, newDates, found.slotInterval);
        if (!parsed.ok) throw new RequestError(400, parsed.error);
        if (!parsed.value) throw new RequestError(400, "proposedSlots is required: list the times for each new date.");
        const added = parsed.value;
        // Already applied, e.g. a CAS replay of this very request after its
        // write committed: every date is there with exactly these times.
        if (newDates.every((d) => found.dates.includes(d) && generateDaySlots(found, d).join() === added[d].join())) {
          return found;
        }
        const duplicate = newDates.find((d) => found.dates.includes(d));
        if (duplicate) throw new RequestError(400, `${duplicate} is already one of the poll dates.`);
        if (found.dates.length + newDates.length > MAX_POLL_DATES) {
          throw new RequestError(400, `A poll can have at most ${MAX_POLL_DATES} dates.`);
        }

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
        const unfit = findDateWithoutMeetingFit(found, newDates);
        if (unfit) throw new RequestError(400, `${unfit} has no ${found.durationMinutes}-minute run of proposed times.`);
        return found;
      });

      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(pollForClient(req, poll, true));
    })
  );

  // ─── Routes: delete ───

  app.delete(
    "/api/polls/:id",
    wrap(async (req, res) => {
      const poll = await pollStore.get(req.params.id);
      // Nothing to remove: 404 without a write.
      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      if (!codeMatches(readCodeHeader(req, ORGANIZER_HEADER), poll.organizerCodeHash)) {
        res.status(403).json({ error: ORGANIZER_ONLY });
        return;
      }
      await pollStore.delete(poll.id);
      res.json({ id: poll.id });
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

      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);
      const editCode = readCodeHeader(req, EDIT_HEADER);
      // A save without participantId creates a response, keyed by its edit code.
      // A client-generated code makes a retried first save idempotent: the
      // retry finds the response by the code's hash and updates it instead.
      const isFirstSave = !participantId;
      if (isFirstSave && editCode !== undefined && !CLIENT_CODE_RE.test(editCode)) {
        res.status(400).json({ error: "X-Edit-Code must be 32-128 characters of A-Z, a-z, 0-9, _ or -." });
        return;
      }
      // Chosen once per request, so a CAS replay of the closure reuses them.
      const firstSaveCode = isFirstSave ? editCode ?? newCode() : undefined;
      const firstSaveHash = firstSaveCode ? hashCode(firstSaveCode) : undefined;
      const newParticipantId = newId("part");

      // Set on the attempt that wrote, so the response is shaped for its caller.
      let isOrganizer = false;

      const outcome = await pollStore.update(req.params.id, (poll) => {
        isOrganizer = codeMatches(organizerCode, poll.organizerCodeHash);
        if (poll.finalizedSlot) throw new RequestError(409, VOTING_CLOSED);

        const proposed = new Set(poll.dates.flatMap((date) =>
          generateDaySlots(poll, date).map((time) => `${date}T${time}`)
        ));
        const invalidSlot = Object.keys(parsedAvailability.value).find((key) => !proposed.has(key));
        if (invalidSlot) {
          throw new RequestError(400, `availability slot ${invalidSlot} is outside the poll's proposed slots.`);
        }

        // Updating needs the response's edit code (or the organizer code). There
        // is no name matching: without an id and code, a save is a new response.
        let existingIdx: number;
        if (participantId) {
          existingIdx = poll.participants.findIndex((p) => p.id === participantId);
          // The poll exists but the response does not: say which was missing.
          if (existingIdx === -1) throw new RequestError(404, "Participant not found");
          if (!isOrganizer && !codeMatches(editCode, poll.participants[existingIdx].editCodeHash)) {
            throw new RequestError(403, "This response can only be changed from the browser that saved it.");
          }
        } else {
          existingIdx = poll.participants.findIndex((p) => codeMatches(firstSaveCode, p.editCodeHash));
        }

        if (existingIdx === -1 && poll.participants.length >= MAX_PARTICIPANTS) {
          throw new RequestError(409, `This poll has reached its limit of ${MAX_PARTICIPANTS} responses.`);
        }

        const existing = existingIdx >= 0 ? poll.participants[existingIdx] : undefined;
        const responseEntry: ParticipantResponse = {
          // Never trust a client-supplied id for a brand-new record.
          id: existing?.id ?? newParticipantId,
          name: name.trim(),
          // An absent field keeps what is stored; an explicit string replaces it.
          email: email === undefined || email === null ? existing?.email ?? "" : optionalText(email),
          timezone:
            timezone === undefined || timezone === null
              ? existing?.timezone || poll.timezone
              : optionalText(timezone) || poll.timezone,
          updatedAt: new Date().toISOString(),
          availability: parsedAvailability.value,
          editCodeHash: existing?.editCodeHash ?? firstSaveHash,
        };

        if (existing) poll.participants[existingIdx] = responseEntry;
        else poll.participants.push(responseEntry);

        return { poll, participant: responseEntry };
      });

      if (!outcome) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      const publicPoll = toPublicPoll(outcome.poll, isOrganizer);
      res.json({
        poll: pollForClient(req, outcome.poll, isOrganizer),
        participant: publicPoll.participants.find((p) => p.id === outcome.participant.id),
        // The code in use for a first save, including a replayed one.
        ...(firstSaveCode ? { editCode: firstSaveCode } : {}),
      });
    })
  );

  app.delete(
    "/api/polls/:id/respond/:participantId",
    wrap(async (req, res) => {
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);

      // Removing a response stays possible while voting is locked.
      const poll = await pollStore.update(req.params.id, (found) => {
        if (!codeMatches(organizerCode, found.organizerCodeHash)) throw new RequestError(403, ORGANIZER_ONLY);
        const remaining = found.participants.filter((p) => p.id !== req.params.participantId);
        // Nothing removed means the id was never here: 404 without a write.
        if (remaining.length === found.participants.length) throw new RequestError(404, "Participant not found");
        found.participants = remaining;
        return found;
      });

      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(pollForClient(req, poll, true));
    })
  );

  // ─── Routes: finalize and reset ───

  app.post(
    "/api/polls/:id/finalize",
    wrap(async (req, res) => {
      const { date, startTime, endTime, confirmedBy } = req.body ?? {};

      // Validation that needs the poll runs inside the mutation, so there is
      // exactly one lookup and one 404 path.
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);

      const poll = await pollStore.update(req.params.id, (found) => {
        if (!codeMatches(organizerCode, found.organizerCodeHash)) throw new RequestError(403, ORGANIZER_ONLY);
        const reject = (error: string): never => {
          throw new RequestError(400, error);
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
          // Already applied, e.g. a CAS replay after this request's write committed.
          const locked = found.finalizedSlot;
          if (locked.date === date && locked.startTime === startTime && locked.endTime === endTime) return found;
          throw new RequestError(409, "Re-open voting before choosing another meeting time.");
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

      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(pollForClient(req, poll, true));
    })
  );

  app.post(
    "/api/polls/:id/reset",
    wrap(async (req, res) => {
      const organizerCode = readCodeHeader(req, ORGANIZER_HEADER);
      const poll = await pollStore.update(req.params.id, (found) => {
        if (!codeMatches(organizerCode, found.organizerCodeHash)) throw new RequestError(403, ORGANIZER_ONLY);
        found.finalizedSlot = null;
        return found;
      });

      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(pollForClient(req, poll, true));
    })
  );

  // ─── Errors ───
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  // JSON error handler - keeps API failures machine-readable
  app.use("/api", (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    // Contention that outlasted the store's retries: the client may simply try again.
    if (err instanceof PollStoreConflictError) {
      res.status(409).json({ error: err.message, retryable: true });
      return;
    }
    // A corrupt stored record: say so instead of a generic failure, and log the cause.
    if (err instanceof PollUnreadableError) {
      console.error("API error:", err, err.cause);
      res.status(500).json({ error: err.message });
      return;
    }
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
