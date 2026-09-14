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
/** Polls kept at once (all polls share one storage record). */
export const MAX_POLLS = 2000;
/** How far ahead a candidate date may be, in days from today (UTC). */
export const MAX_DAYS_AHEAD = 366;
/** Largest accepted JSON request body. 60 days of 15-minute answers is ~190 kB. */
export const MAX_BODY_SIZE = '256kb';

/** Poll ids are generated server-side from [a-z0-9_]; anything else is not a poll. */
export const POLL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Latest allowed YYYY-MM-DD for a candidate date, counted from `now` in UTC. */
export function latestPollDate(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + MAX_DAYS_AHEAD);
  return day.toISOString().slice(0, 10);
}
