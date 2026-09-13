import { describe, expect, it } from 'vitest';
import type { Poll } from '../src/types';
import type { PollStore } from '../server/poll-store';
import {
  cleanupExpiredPolls,
  isPollExpired,
  pruneExpiredPolls,
  RETENTION_DAYS,
  withRetention,
} from '../server/retention';

const makePoll = (id: string, dates: string[]): Poll => ({
  id,
  title: id,
  description: '',
  durationMinutes: 30,
  timezone: 'UTC',
  dates,
  startHour: 9,
  endHour: 17,
  slotInterval: 30,
  creatorName: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  finalizedSlot: null,
  participants: [],
});

/** In-memory store that counts writes, like the real stores skip null results. */
function memoryStore(initial: Poll[]) {
  let polls = structuredClone(initial);
  let writes = 0;
  const store: PollStore = {
    async load() {
      return structuredClone(polls);
    },
    async mutate(fn) {
      const draft = structuredClone(polls);
      const result = fn(draft);
      if (result !== null && result !== undefined) {
        polls = draft;
        writes += 1;
      }
      return result;
    },
  };
  return { store, raw: () => polls, writes: () => writes };
}

const at = (iso: string) => new Date(iso);

describe('poll retention rule', () => {
  it(`keeps a poll through ${RETENTION_DAYS} days after its last date, then expires it`, () => {
    const poll = makePoll('p', ['2026-09-20', '2026-10-01']);
    expect(isPollExpired(poll, at('2026-10-01T12:00:00Z'))).toBe(false);
    expect(isPollExpired(poll, at('2026-10-15T23:59:59Z'))).toBe(false);
    expect(isPollExpired(poll, at('2026-10-16T00:00:00Z'))).toBe(true);
  });

  it('uses the latest date even when dates are unsorted', () => {
    const poll = makePoll('p', ['2026-10-01', '2026-08-01']);
    expect(isPollExpired(poll, at('2026-08-20T00:00:00Z'))).toBe(false);
  });

  it('crosses month and year boundaries', () => {
    expect(isPollExpired(makePoll('p', ['2026-12-25']), at('2027-01-08T10:00:00Z'))).toBe(false);
    expect(isPollExpired(makePoll('p', ['2026-12-25']), at('2027-01-09T00:00:00Z'))).toBe(true);
  });

  it('never expires a poll without usable dates', () => {
    expect(isPollExpired(makePoll('p', []), at('2099-01-01T00:00:00Z'))).toBe(false);
    expect(isPollExpired(makePoll('p', ['not-a-date']), at('2099-01-01T00:00:00Z'))).toBe(false);
  });

  it('prunes in place and reports the count', () => {
    const polls = [makePoll('old', ['2026-08-01']), makePoll('new', ['2026-10-01'])];
    expect(pruneExpiredPolls(polls, at('2026-09-13T00:00:00Z'))).toBe(1);
    expect(polls.map((p) => p.id)).toEqual(['new']);
  });
});

describe('retention store wrapper', () => {
  const clock = () => at('2026-09-13T12:00:00Z');
  const seed = [makePoll('old', ['2026-08-01']), makePoll('recent', ['2026-09-05']), makePoll('future', ['2026-10-01'])];

  it('hides expired polls from reads without writing', async () => {
    const mem = memoryStore(seed);
    const polls = await withRetention(mem.store, clock).load();
    expect(polls.map((p) => p.id)).toEqual(['recent', 'future']);
    expect(mem.writes()).toBe(0);
  });

  it('removes expired polls on the next real write', async () => {
    const mem = memoryStore(seed);
    const wrapped = withRetention(mem.store, clock);
    await wrapped.mutate(() => null);
    expect(mem.raw()).toHaveLength(3);
    await wrapped.mutate((polls) => {
      polls[0].title = 'edited';
      return true;
    });
    expect(mem.raw().map((p) => p.id)).toEqual(['recent', 'future']);
  });

  it('cleanup deletes expired polls and writes only when something was removed', async () => {
    const mem = memoryStore(seed);
    expect(await cleanupExpiredPolls(mem.store, clock)).toBe(1);
    expect(mem.raw().map((p) => p.id)).toEqual(['recent', 'future']);
    expect(mem.writes()).toBe(1);
    expect(await cleanupExpiredPolls(mem.store, clock)).toBe(0);
    expect(mem.writes()).toBe(1);
  });
});
