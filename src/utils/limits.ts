// ─── Input limits ───
// Shared by the API (enforced) and the forms (maxLength, pickers), so the UI
// never lets someone type what the server will reject.

export const MAX_TITLE_LENGTH = 120;
export const MAX_LOCATION_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_NAME_LENGTH = 80;
export const MAX_EMAIL_LENGTH = 160;
export const MAX_TIMEZONE_LENGTH = 64;
export const MAX_ID_LENGTH = 64;

/** Candidate dates per poll, including dates added later. */
export const MAX_POLL_DATES = 60;
/** Responses per poll. */
export const MAX_PARTICIPANTS = 200;
/** Availability entries in one response: every 15-minute slot of every date. */
export const MAX_AVAILABILITY_ENTRIES = MAX_POLL_DATES * 96;
/**
 * Largest stored poll, measured as compact JSON bytes of the storage format
 * (availability packed to one character per 15-minute slot). The largest valid
 * poll - MAX_POLL_DATES full days, MAX_PARTICIPANTS responses answering every
 * slot, every text field at its limit in characters JSON must escape - stores in
 * about 1.81 MB, so normal use never reaches this; it only guards against
 * corrupt or abusive records. Each poll is its own storage record.
 */
export const MAX_POLL_BYTES = 2_000_000;
/** How far ahead a candidate date may be, in days from today (UTC). */
export const MAX_DAYS_AHEAD = 366;
/** Largest accepted JSON request body. 60 days of 15-minute answers is ~190 kB. */
export const MAX_BODY_SIZE = '256kb';

/** Poll ids are generated server-side as base64url; anything else is not a poll. */
export const POLL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Earliest allowed YYYY-MM-DD for a new candidate date: yesterday in UTC. The
 * day of slack covers browsers whose local "today" is still yesterday in UTC.
 */
export function earliestPollDate(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Latest allowed YYYY-MM-DD for a candidate date, counted from `now` in UTC. */
export function latestPollDate(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + MAX_DAYS_AHEAD);
  return day.toISOString().slice(0, 10);
}
