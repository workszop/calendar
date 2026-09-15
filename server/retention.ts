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

/** Whether retention removes this poll at `now`. */
export function isPollRetired(poll: Poll, now: Date): boolean {
  return isPollExpired(poll, now) || isLegacyPoll(poll);
}

/**
 * Wraps a store so retired polls are invisible to every read. A write aimed at
 * a retired poll deletes it instead and reports it missing; the scheduled
 * cleanup covers polls nobody touches.
 */
export function withRetention(store: PollStore, clock: Clock = () => new Date()): PollStore {
  const visible = (poll: Poll | null) => (poll && !isPollRetired(poll, clock()) ? poll : null);
  return {
    async get(id) {
      return visible(await store.get(id));
    },
    async getMany(ids) {
      return (await store.getMany(ids)).filter((poll) => visible(poll));
    },
    create: (poll) => store.create(poll),
    async update(id, fn) {
      let retired = false;
      const result = await store.update(id, (draft) => {
        // May run again after a CAS conflict.
        retired = isPollRetired(draft, clock());
        return retired ? null : fn(draft);
      });
      if (retired) await store.delete(id);
      return result;
    },
    delete: (id) => store.delete(id),
    listIds: () => store.listIds(),
  };
}

/**
 * Deletes retired polls now: imports any old-layout records worth keeping,
 * then sweeps every stored poll. Resolves with how many polls were removed.
 */
export async function cleanupExpiredPolls(store: PollStore, clock: Clock = () => new Date()): Promise<number> {
  let removed = 0;
  if (store.importLegacyPolls) {
    removed += (await store.importLegacyPolls((poll) => !isPollRetired(poll, clock()))).dropped;
  }
  for (const id of await store.listIds()) {
    const poll = await store.get(id);
    if (poll && isPollRetired(poll, clock())) {
      await store.delete(id);
      removed += 1;
    }
  }
  return removed;
}
