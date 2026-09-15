import type { Config } from '@netlify/functions';
import { createNetlifyPollStore } from '../../server/netlify-store';
import { cleanupExpiredPolls, RETENTION_DAYS } from '../../server/retention';

// Daily retention sweep: deletes polls whose last date is more than
// RETENTION_DAYS in the past, and polls without an organizer code, even if
// nobody opens the app. It also moves polls out of the old single "polls"
// array blob into per-poll blobs and deletes that array. Netlify runs
// scheduled functions only on the published (production) deploy.
export default async (): Promise<Response> => {
  const removed = await cleanupExpiredPolls(createNetlifyPollStore());
  console.log(`Poll cleanup: removed ${removed} poll(s) older than ${RETENTION_DAYS} days past their last date`);
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: '@daily',
};
