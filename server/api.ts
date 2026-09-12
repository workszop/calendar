import express from "express";
import type { DayHours, Poll, ParticipantResponse, PollSummary, SlotStatus } from "../src/types";
import { generateDaySlots, getDayHours, getMeetingWindow, isHalfHourValue, isValidHourWindow } from "../src/utils/consensus";
import { createFilePollStore, type PollStore } from "./poll-store";

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

/** Builds the JSON API. A string keeps the original file-backed API; a PollStore enables cloud storage. */
export function createApi(source: string | PollStore) {
  const app = express();
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "5mb" }));

  // ─── Storage ───
  const pollStore = typeof source === "string" ? createFilePollStore(source) : source;

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

  // List all polls
  app.get("/api/polls", wrap(async (_req, res) => {
    const polls = await pollStore.load();
    const summaries: PollSummary[] = polls.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      location: p.location,
      durationMinutes: p.durationMinutes,
      timezone: p.timezone,
      dates: p.dates,
      creatorName: p.creatorName,
      createdAt: p.createdAt,
      finalizedSlot: p.finalizedSlot,
      participantsCount: p.participants.length,
    }));
    res.json(summaries);
  }));

  // Get single poll
  app.get("/api/polls/:id", wrap(async (req, res) => {
    const polls = await pollStore.load();
    const poll = polls.find((p) => p.id === req.params.id);
    if (!poll) {
      res.status(404).json({ error: "Poll not found" });
      return;
    }
    res.json(poll);
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

      const rawDates = body.dates as unknown[];
      const badDate = rawDates.find((d) => !isCalendarDate(d));
      if (badDate !== undefined) {
        res.status(400).json({ error: `Invalid date "${String(badDate)}" - expected YYYY-MM-DD.` });
        return;
      }
      const dates = [...new Set(rawDates as string[])].sort();

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
      const startHour = hasStart ? (body.startHour as number) : 9;
      const endHour = hasEnd ? (body.endHour as number) : 17;
      if (startHour >= endHour) {
        res.status(400).json({ error: "startHour must be before endHour." });
        return;
      }

      const dayHours = parseDayHours(body.dayHours, dates);
      if (!dayHours.ok) {
        res.status(400).json({ error: dayHours.error });
        return;
      }

      const id = "poll_" + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
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
        slotInterval,
        creatorName: optionalText(body.creatorName, "Organizer"),
        creatorEmail: optionalText(body.creatorEmail),
        createdAt: new Date().toISOString(),
        finalizedSlot: null,
        participants: [],
      };

      await pollStore.mutate((polls) => {
        // A CAS write may have committed before its response was lost. If
        // the store replays this closure, the allocated id makes the create
        // idempotent instead of inserting the same poll twice.
        const existing = polls.find((poll) => poll.id === newPoll.id);
        if (existing) return existing;
        polls.unshift(newPoll);
        return newPoll;
      });
      res.status(201).json(newPoll);
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
      const parsedAvailability = parseAvailability(availability);
      if (!parsedAvailability.ok) {
        res.status(400).json({ error: parsedAvailability.error });
        return;
      }

      // Set when the poll exists but the supplied participantId does not, so
      // the 404 can say which of the two was missing.
      let unknownParticipant = false;
      let invalidSlot: string | undefined;

      const outcome = await pollStore.mutate((polls) => {
        // Blob CAS may replay this closure. Never let an earlier attempt's
        // diagnostic flags leak into the final response.
        unknownParticipant = false;
        invalidSlot = undefined;
        const poll = polls.find((candidate) => candidate.id === req.params.id);
        if (!poll) return null;
        const proposed = new Set(poll.dates.flatMap((date) =>
          generateDaySlots(poll, date).map((time) => `${date}T${time}`)
        ));
        invalidSlot = Object.keys(parsedAvailability.value).find((key) => !proposed.has(key));
        if (invalidSlot) return null;

        // A supplied id must resolve: falling back to a name match would let a
        // stale id silently overwrite somebody else's response.
        let existingIdx = -1;
        if (participantId) {
          existingIdx = poll.participants.findIndex((p) => p.id === participantId);
          if (existingIdx === -1) {
            unknownParticipant = true;
            return null;
          }
        } else {
          const needle = name.trim().toLowerCase();
          existingIdx = poll.participants.findIndex((p) => p.name.trim().toLowerCase() === needle);
        }

        // Never trust a client-supplied id for a brand-new record.
        const id =
          existingIdx >= 0
            ? poll.participants[existingIdx].id
            : "part_" + Math.random().toString(36).substring(2, 9);

        const responseEntry: ParticipantResponse = {
          id,
          name: name.trim(),
          email: optionalText(email),
          timezone: optionalText(timezone) || poll.timezone,
          updatedAt: new Date().toISOString(),
          availability: parsedAvailability.value,
        };

        if (existingIdx >= 0) poll.participants[existingIdx] = responseEntry;
        else poll.participants.push(responseEntry);

        return { poll, participant: responseEntry };
      });

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
      res.json(outcome);
    })
  );

  app.delete(
    "/api/polls/:id/respond/:participantId",
    wrap(async (req, res) => {
      let unknownParticipant = false;

      const poll = await pollStore.mutate((polls) => {
        unknownParticipant = false;
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
        const remaining = found.participants.filter((p) => p.id !== req.params.participantId);
        // Nothing removed means the id was never here: 404 without a write.
        if (remaining.length === found.participants.length) {
          unknownParticipant = true;
          return null;
        }
        found.participants = remaining;
        return found;
      });

      if (!poll) {
        res
          .status(404)
          .json({ error: unknownParticipant ? "Participant not found" : "Poll not found" });
        return;
      }
      res.json(poll);
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

      const poll = await pollStore.mutate((polls) => {
        // Validation may run again after a CAS conflict.
        failure = null;
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
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
      res.json(poll);
    })
  );

  app.post(
    "/api/polls/:id/reset",
    wrap(async (req, res) => {
      const poll = await pollStore.mutate((polls) => {
        const found = polls.find((candidate) => candidate.id === req.params.id);
        if (!found) return null;
        found.finalizedSlot = null;
        return found;
      });

      if (!poll) {
        res.status(404).json({ error: "Poll not found" });
        return;
      }
      res.json(poll);
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
