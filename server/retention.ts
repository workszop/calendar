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

// ─── Scheduled cleanup ───

/** Polls checked at once by the sweep. */
export const DEFAULT_CLEANUP_CONCURRENCY = 10;
/**
 * Time the sweep may spend before it stops taking new polls. Netlify stops a
 * scheduled function after 30 seconds; this leaves room for the running reads,
 * deletes and the log line.
 */
export const DEFAULT_CLEANUP_BUDGET_MS = 20_000;

export interface CleanupOptions {
  /** Calendar time for the retention rule. */
  clock?: Clock;
  /** Polls checked at once. */
  concurrency?: number;
  /** Stop taking new polls once this many ms have passed since the start. */
  timeBudgetMs?: number;
  /** Millisecond timer for the budget. */
  now?: () => number;
  /** Source of the random sweep order. */
  random?: () => number;
}

export interface CleanupReport {
  /** Polls deleted, including old-layout records not worth keeping. */
  removed: number;
  /** Polls moved out of the old layout. */
  imported: number;
  /** Old-layout records that were not readable polls. */
  skipped: number;
  /** Old-layout records not reached before the time budget ran out. */
  legacyRemaining: number;
  /** Whether moving the old layout failed (the sweep still ran). */
  legacyFailed: boolean;
  /** Stored polls looked at by the sweep. */
  checked: number;
  /** Polls whose check or delete threw. */
  failed: number;
  /** Polls not reached before the time budget ran out. */
  remaining: number;
}

/** One log line for a cleanup run. */
export function formatCleanupReport(report: CleanupReport): string {
  return [
    `Poll cleanup: removed ${report.removed} poll(s) past ${RETENTION_DAYS} days after their last date or without an organizer code`,
    `checked ${report.checked}`,
    `moved ${report.imported} from the old layout`,
    `skipped ${report.skipped} malformed old record(s)`,
    ...(report.failed ? [`${report.failed} failed`] : []),
    ...(report.legacyFailed ? ["legacy import failed"] : []),
    ...(report.legacyRemaining ? [`${report.legacyRemaining} old-layout record(s) left for the next run`] : []),
    ...(report.remaining ? [`${report.remaining} left for the next run`] : []),
  ].join("; ");
}

/** Fisher-Yates shuffle into a new array. */
function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Deletes retired polls now: imports any old-layout records worth keeping, then
 * sweeps every stored poll with bounded parallelism until the time budget runs
 * out. The import shares that budget, so a large old layout is moved over
 * several runs instead of being cut off before it can delete itself. Each run
 * visits polls in a new random order, so polls a run did not reach get their
 * turn on a later one. Failures are logged and counted, never thrown.
 */
export async function cleanupExpiredPolls(store: PollStore, options: CleanupOptions = {}): Promise<CleanupReport> {
  const clock = options.clock ?? (() => new Date());
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CLEANUP_CONCURRENCY);
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_CLEANUP_BUDGET_MS;
  const started = now();
  const outOfTime = () => now() - started >= timeBudgetMs;
  const report: CleanupReport = {
    removed: 0,
    imported: 0,
    skipped: 0,
    legacyRemaining: 0,
    legacyFailed: false,
    checked: 0,
    failed: 0,
    remaining: 0,
  };

  if (store.importLegacyPolls) {
    try {
      const legacy = await store.importLegacyPolls((poll) => !isPollRetired(poll, clock()), { shouldStop: outOfTime });
      report.removed += legacy.dropped;
      report.imported = legacy.imported;
      report.skipped = legacy.skipped;
      report.legacyRemaining = legacy.remaining;
    } catch (err) {
      report.legacyFailed = true;
      console.error("Poll cleanup: moving the old poll layout failed; sweeping per-poll records anyway:", err);
    }
  }

  const queue = shuffled(await store.listIds(), options.random ?? Math.random);
  const worker = async () => {
    while (queue.length && !outOfTime()) {
      const id = queue.pop()!;
      report.checked += 1;
      try {
        const poll = await store.get(id);
        if (poll && isPollRetired(poll, clock())) {
          await store.delete(id);
          report.removed += 1;
        }
      } catch (err) {
        report.failed += 1;
        console.error(`Poll cleanup: checking ${id} failed:`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  report.remaining = queue.length;
  return report;
}
