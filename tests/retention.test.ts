import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Poll } from '../src/types';
import { createBlobPollStore } from '../server/blob-store';
import { createFilePollStore, type PollStore } from '../server/poll-store';
import {
  cleanupExpiredPolls,
  DEFAULT_CLEANUP_BUDGET_MS,
  formatCleanupReport,
  isLegacyPoll,
  isPollExpired,
  isPollRetired,
  RETENTION_DAYS,
  withRetention,
} from '../server/retention';
import { MemoryBlobClient } from './memory-blob-client';

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
  organizerCodeHash: 'a'.repeat(64),
});

/** A blob store seeded with polls, plus its client for raw assertions. */
async function seededStore(polls: Poll[]) {
  const client = new MemoryBlobClient();
  for (const poll of polls) client.seed(`poll/${poll.id}`, poll);
  return { client, store: createBlobPollStore(client) };
}

const at = (iso: string) => new Date(iso);

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('retires expired and legacy polls alike', () => {
    const now = at('2026-09-13T00:00:00Z');
    expect(isPollRetired(makePoll('old', ['2026-08-01']), now)).toBe(true);
    expect(isPollRetired({ ...makePoll('legacy', ['2026-12-01']), organizerCodeHash: undefined }, now)).toBe(true);
    expect(isPollRetired(makePoll('new', ['2026-10-01']), now)).toBe(false);
  });
});

describe('retention store wrapper', () => {
  const clock = () => at('2026-09-13T12:00:00Z');
  const seed = [makePoll('old', ['2026-08-01']), makePoll('recent', ['2026-09-05']), makePoll('future', ['2026-10-01'])];

  it('hides expired polls from reads without writing', async () => {
    const { client, store } = await seededStore(seed);
    const wrapped = withRetention(store, clock);
    await expect(wrapped.get('old')).resolves.toBeNull();
    expect((await wrapped.get('recent'))?.id).toBe('recent');
    expect((await wrapped.getMany(['old', 'recent', 'future'])).map((p) => p.id)).toEqual(['recent', 'future']);
    expect(client.writeCalls).toHaveLength(0);
    expect(client.deleteCalls).toHaveLength(0);
  });

  it('deletes an expired poll when a write targets it, and leaves other polls alone', async () => {
    const { client, store } = await seededStore(seed);
    const wrapped = withRetention(store, clock);
    let called = false;
    await expect(wrapped.update('old', () => (called = true))).resolves.toBeNull();
    expect(called).toBe(false);
    expect(client.keys()).toEqual(['poll/future', 'poll/recent']);
    await expect(wrapped.update('recent', (draft) => (draft.title = 'edited'))).resolves.toBe('edited');
    expect(client.keys()).toEqual(['poll/future', 'poll/recent']);
  });

  it('cleanup deletes expired polls and writes nothing when nothing expired', async () => {
    const { client, store } = await seededStore(seed);
    expect((await cleanupExpiredPolls(store, { clock })).removed).toBe(1);
    expect(client.keys()).toEqual(['poll/future', 'poll/recent']);
    expect((await cleanupExpiredPolls(store, { clock })).removed).toBe(0);
    expect(client.writeCalls).toHaveLength(0);
    expect(client.deleteCalls).toEqual(['poll/old']);
  });

  it('cleanup moves live polls out of the legacy array and deletes the array key', async () => {
    const client = new MemoryBlobClient();
    const legacyOwnerless = { ...makePoll('ownerless', ['2026-12-01']), organizerCodeHash: undefined };
    client.seed('polls', [makePoll('old', ['2026-08-01']), makePoll('kept', ['2026-10-01']), legacyOwnerless]);
    client.seed('poll/stale', makePoll('stale', ['2026-01-01']));
    const store = createBlobPollStore(client);

    expect(await cleanupExpiredPolls(store, { clock })).toMatchObject({ removed: 3, imported: 1, skipped: 0, remaining: 0 });
    expect(client.keys()).toEqual(['poll/kept']);
  });

  it('gives the legacy import the same time budget and finishes it on a later run', async () => {
    const client = new MemoryBlobClient();
    const legacy = Array.from({ length: 6 }, (_, i) => makePoll(`legacy_${i}`, ['2026-10-01']));
    client.seed('polls', legacy);
    client.seed('poll/old', makePoll('old', ['2026-08-01']));
    const store = createBlobPollStore(client, { concurrency: 1 });

    // Every write costs a second; the budget allows three.
    let elapsed = 0;
    const write = client.setJSON.bind(client);
    client.setJSON = async (key, data, options) => {
      elapsed += 1000;
      return write(key, data, options);
    };
    const first = await cleanupExpiredPolls(store, { clock, timeBudgetMs: 3000, now: () => elapsed });
    expect(first).toMatchObject({ imported: 3, legacyRemaining: 3, checked: 0, remaining: 4 });
    expect(formatCleanupReport(first)).toMatch(/3 old-layout record\(s\) left for the next run/);
    expect(client.keys()).toContain('polls');

    elapsed = 0;
    const second = await cleanupExpiredPolls(store, { clock, timeBudgetMs: 60_000, now: () => elapsed });
    expect(second).toMatchObject({ imported: 3, legacyRemaining: 0, removed: 1, remaining: 0 });
    expect(client.keys()).toEqual(legacy.map((poll) => `poll/${poll.id}`));
  });

  it('hides expired and ownerless polls that are still in the legacy array', async () => {
    const client = new MemoryBlobClient();
    const ownerless = { ...makePoll('ownerless', ['2026-12-01']), organizerCodeHash: undefined };
    client.seed('polls', [makePoll('old', ['2026-08-01']), makePoll('kept', ['2026-10-01']), ownerless]);
    const wrapped = withRetention(createBlobPollStore(client), clock);
    await expect(wrapped.get('old')).resolves.toBeNull();
    await expect(wrapped.get('ownerless')).resolves.toBeNull();
    expect((await wrapped.getMany(['old', 'kept', 'ownerless'])).map((p) => p.id)).toEqual(['kept']);
    // A write aimed at a retired legacy poll removes it from the array too.
    await expect(wrapped.update('ownerless', () => true)).resolves.toBeNull();
    expect((client.peek('polls') as Poll[]).map((p) => p.id)).toEqual(['old', 'kept']);
  });

  it('cleanup still deletes expired polls when a legacy entry is malformed', async () => {
    const client = new MemoryBlobClient();
    client.seed('polls', [null, { id: 42 }, makePoll('legacy_old', ['2026-08-01']), makePoll('legacy_kept', ['2026-10-01'])]);
    client.seed('poll/old', makePoll('old', ['2026-08-01']));
    client.seed('poll/future', makePoll('future', ['2026-10-01']));
    const report = await cleanupExpiredPolls(createBlobPollStore(client), { clock });
    expect(report).toMatchObject({ removed: 2, imported: 1, skipped: 2, failed: 0, legacyFailed: false });
    expect(client.keys()).toEqual(['poll/future', 'poll/legacy_kept']);
  });

  it('cleanup logs a failed legacy import and still sweeps every poll', async () => {
    const client = new MemoryBlobClient();
    client.seed('polls', { not: 'an array' });
    client.seed('poll/old', makePoll('old', ['2026-08-01']));
    client.seed('poll/corrupt', ['not', 'a poll']);
    client.seed('poll/older', makePoll('older', ['2026-07-01']));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await cleanupExpiredPolls(createBlobPollStore(client), { clock });
    expect(report).toMatchObject({ removed: 2, failed: 1, legacyFailed: true, remaining: 0 });
    expect(client.keys()).toEqual(['poll/corrupt', 'polls']);
    expect(errors).toHaveBeenCalled();
    expect(formatCleanupReport(report)).toMatch(/removed 2.*1 failed.*legacy import failed/);
  });

  it('cleanup works the same on the file store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-retention-'));
    try {
      const file = path.join(dir, 'polls.json');
      fs.writeFileSync(file, JSON.stringify([...seed, { ...makePoll('legacy', ['2026-12-01']), organizerCodeHash: undefined }]));
      const store = createFilePollStore(file);
      expect((await cleanupExpiredPolls(store, { clock })).removed).toBe(2);
      expect((await store.listIds()).sort()).toEqual(['future', 'recent']);
      const before = fs.statSync(file).mtimeMs;
      expect((await cleanupExpiredPolls(store, { clock })).removed).toBe(0);
      expect(fs.statSync(file).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy polls without an organizer code', () => {
  it('are recognised by the missing hash', () => {
    const legacy = { ...makePoll('legacy', ['2026-12-01']), organizerCodeHash: undefined };
    expect(isLegacyPoll(legacy)).toBe(true);
    expect(isLegacyPoll(makePoll('current', ['2026-12-01']))).toBe(false);
  });
});

describe('cleanup at scale', () => {
  const clock = () => at('2026-09-13T12:00:00Z');

  /** Wraps a store so tests can watch how many reads run at once. */
  function instrumented(store: PollStore, onGet: () => void = () => {}) {
    let active = 0;
    let peak = 0;
    const wrapped: PollStore = {
      ...store,
      async get(id) {
        active += 1;
        peak = Math.max(peak, active);
        onGet();
        try {
          return await store.get(id);
        } finally {
          active -= 1;
        }
      },
    };
    return { wrapped, peak: () => peak };
  }

  /** Small deterministic PRNG, so the sweep order is reproducible. */
  const seeded = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };

  it('sweeps with bounded parallelism', async () => {
    const polls = Array.from({ length: 40 }, (_, i) => makePoll(`old_${i}`, ['2026-08-01']));
    const { client, store } = await seededStore(polls);
    const { wrapped, peak } = instrumented(store);
    const report = await cleanupExpiredPolls(wrapped, { clock, concurrency: 10 });
    expect(report).toMatchObject({ removed: 40, checked: 40, remaining: 0 });
    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBeLessThanOrEqual(10);
    expect(client.keys()).toEqual([]);
  });

  it('stops before its time budget and reports how many polls were left', async () => {
    const polls = Array.from({ length: 12 }, (_, i) => makePoll(`old_${i}`, ['2026-08-01']));
    const { store } = await seededStore(polls);
    let elapsed = 0;
    const { wrapped } = instrumented(store, () => (elapsed += 1000));
    const report = await cleanupExpiredPolls(wrapped, { clock, concurrency: 1, timeBudgetMs: 5000, now: () => elapsed });
    expect(report).toMatchObject({ checked: 5, removed: 5, remaining: 7 });
    expect(formatCleanupReport(report)).toMatch(/7 left for the next run/);
    expect(DEFAULT_CLEANUP_BUDGET_MS).toBeLessThan(30_000);
  });

  it('visits polls in a fresh random order each run, so leftovers are reached on later runs', async () => {
    // Listing order puts every live poll before the expired ones.
    const live = Array.from({ length: 20 }, (_, i) => makePoll(`a_live_${String(i).padStart(2, '0')}`, ['2026-10-01']));
    const expired = Array.from({ length: 5 }, (_, i) => makePoll(`z_old_${i}`, ['2026-08-01']));
    const { client, store } = await seededStore([...live, ...expired]);
    const random = seeded(7);
    let runs = 0;
    while (client.keys().some((key) => key.startsWith('poll/z_old')) && runs < 40) {
      let elapsed = 0;
      const { wrapped } = instrumented(store, () => (elapsed += 1000));
      await cleanupExpiredPolls(wrapped, { clock, concurrency: 1, timeBudgetMs: 5000, now: () => elapsed, random });
      runs += 1;
    }
    expect(client.keys().filter((key) => key.startsWith('poll/z_old'))).toEqual([]);
    expect(client.keys()).toHaveLength(20);
  });
});
