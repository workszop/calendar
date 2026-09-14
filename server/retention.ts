import type { Poll } from "../src/types";
import type { PollStore } from "./poll-store";

// ─── Poll retention ───
// A poll is deleted once its last proposed date is more than RETENTION_DAYS in
// the past. Dates are compared as UTC calendar days, so a poll whose last date
// is 2026-10-01 lives through 2026-10-15 and is gone from 2026-10-16.

export const RETENTION_DAYS = 14;

export type Clock = () => Date;

/** Last YYYY-MM-DD a poll may still exist on, for a given last poll date. */
function lastKeepDay(lastDate: string): string {
  const day = new Date(`${lastDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + RETENTION_DAYS);
  return day.toISOString().slice(0, 10);
}

export function isPollExpired(poll: Poll, now: Date): boolean {
  // A poll without valid dates is never removed by retention.
  const lastDate = [...(poll.dates ?? [])].sort().at(-1);
  if (!lastDate || Number.isNaN(Date.parse(`${lastDate}T00:00:00Z`))) return false;
  return now.toISOString().slice(0, 10) > lastKeepDay(lastDate);
}

/**
 * Polls created before organizer codes existed have no owner, so nobody could
 * ever manage them. They are retired the same way as expired polls.
 */
export function isLegacyPoll(poll: Poll): boolean {
  return typeof poll.organizerCodeHash !== "string" || !poll.organizerCodeHash;
}

/** Removes expired and legacy polls from the array in place; returns how many were removed. */
export function pruneExpiredPolls(polls: Poll[], now: Date): number {
  const before = polls.length;
  const kept = polls.filter((poll) => !isPollExpired(poll, now) && !isLegacyPoll(poll));
  polls.splice(0, polls.length, ...kept);
  return before - kept.length;
}

/**
 * Wraps a store so expired polls are invisible to every read and physically
 * removed by the next write. A mutation whose own result is null still skips
 * the write; the scheduled cleanup covers stores nobody writes to.
 */
export function withRetention(store: PollStore, clock: Clock = () => new Date()): PollStore {
  return {
    async load() {
      const polls = await store.load();
      pruneExpiredPolls(polls, clock());
      return polls;
    },
    mutate(fn) {
      return store.mutate((polls) => {
        pruneExpiredPolls(polls, clock());
        return fn(polls);
      });
    },
  };
}

/** Deletes expired polls now. Writes only when something was removed. */
export async function cleanupExpiredPolls(store: PollStore, clock: Clock = () => new Date()): Promise<number> {
  const removed = await store.mutate((polls) => {
    const count = pruneExpiredPolls(polls, clock());
    return count > 0 ? count : null;
  });
  return removed ?? 0;
}
