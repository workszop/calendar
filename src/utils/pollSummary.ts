import type { Poll, PollSummary } from '../types';

// ─── Poll summary ───
// The list-view shape of a poll. Shared by the API list route and the app's
// confirm dialogs, so the two can never drift.

export function toPollSummary(poll: Poll): PollSummary {
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
