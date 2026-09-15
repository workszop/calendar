import type { Config } from '@netlify/functions';
import { createNetlifyPollStore } from '../../server/netlify-store';
import { cleanupExpiredPolls, DEFAULT_CLEANUP_BUDGET_MS, formatCleanupReport } from '../../server/retention';

// Daily retention sweep: deletes polls whose last date is more than
// RETENTION_DAYS in the past, and polls without an organizer code, even if
// nobody opens the app. It also moves polls out of the old single "polls"
// array blob into per-poll blobs and deletes that array. Netlify runs
// scheduled functions only on the published (production) deploy, and stops
// them after 30 seconds, so the sweep stops taking new polls after
// CLEANUP_TIME_BUDGET_MS (default 20 s); polls it did not reach are checked on a
// later run.
export default async (): Promise<Response> => {
  const budget = Number(process.env.CLEANUP_TIME_BUDGET_MS);
  const report = await cleanupExpiredPolls(createNetlifyPollStore(), {
    timeBudgetMs: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_CLEANUP_BUDGET_MS,
  });
  console.log(formatCleanupReport(report));
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: '@daily',
};
