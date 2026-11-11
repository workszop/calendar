// ─── Poll links ───

/** The link participants open to answer a poll. */
export function pollShareUrl(pollId: string): string {
  return `${window.location.origin}${window.location.pathname}?poll=${encodeURIComponent(pollId)}`;
}
