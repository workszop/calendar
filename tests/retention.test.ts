import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Poll } from '../src/types';
import { createBlobPollStore } from '../server/blob-store';
import { createFilePollStore } from '../server/poll-store';
import {
  cleanupExpiredPolls,
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
    expect(await cleanupExpiredPolls(store, clock)).toBe(1);
    expect(client.keys()).toEqual(['poll/future', 'poll/recent']);
    expect(await cleanupExpiredPolls(store, clock)).toBe(0);
    expect(client.writeCalls).toHaveLength(0);
    expect(client.deleteCalls).toEqual(['poll/old']);
  });

  it('cleanup moves live polls out of the legacy array and deletes the array key', async () => {
    const client = new MemoryBlobClient();
    const legacyOwnerless = { ...makePoll('ownerless', ['2026-12-01']), organizerCodeHash: undefined };
    client.seed('polls', [makePoll('old', ['2026-08-01']), makePoll('kept', ['2026-10-01']), legacyOwnerless]);
    client.seed('poll/stale', makePoll('stale', ['2026-01-01']));
    const store = createBlobPollStore(client);

    expect(await cleanupExpiredPolls(store, clock)).toBe(3);
    expect(client.keys()).toEqual(['poll/kept']);
  });

  it('cleanup works the same on the file store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-retention-'));
    try {
      const file = path.join(dir, 'polls.json');
      fs.writeFileSync(file, JSON.stringify([...seed, { ...makePoll('legacy', ['2026-12-01']), organizerCodeHash: undefined }]));
      const store = createFilePollStore(file);
      expect(await cleanupExpiredPolls(store, clock)).toBe(2);
      expect((await store.listIds()).sort()).toEqual(['future', 'recent']);
      const before = fs.statSync(file).mtimeMs;
      expect(await cleanupExpiredPolls(store, clock)).toBe(0);
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
