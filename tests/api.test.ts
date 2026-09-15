import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { createApi } from '../server/api';
import {
  clientKey,
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
  rateLimitsFromEnv,
  trustProxyFromEnv,
} from '../server/rate-limit';
import { MAX_AVAILABILITY_ENTRIES, MAX_POLL_BYTES } from '../src/utils/limits';

// ─── Fixture: a real HTTP server backed by a throwaway data file ───
let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-'));
  // Pinned clock: fixture dates must not expire as real time passes. The suite
  // creates far more polls than one visitor may; rate limits have their own tests.
  const app = createApi(path.join(tmpDir, 'polls.json'), {
    clock: () => new Date('2026-09-13T12:00:00Z'),
    rateLimit: false,
  });
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.once('error', reject);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Organizer codes of polls created through `api`, so organizer routes work by
// default. Participant saves (POST …/respond) never send it; pass
// `{ guest: true }` to act as a visitor, or explicit headers to override.
const organizerCodes = new Map<string, string>();

const api = async (
  method: string,
  url: string,
  body?: unknown,
  options: { guest?: boolean; headers?: Record<string, string> } = {}
) => {
  const pollId = /^\/api\/polls\/([^/?]+)/.exec(url)?.[1];
  const isRespond = method === 'POST' && /\/respond$/.test(url);
  const code = pollId && !options.guest && !isRespond ? organizerCodes.get(pollId) : undefined;
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(code ? { 'X-Organizer-Code': code } : {}),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (method === 'POST' && url === '/api/polls' && res.status === 201) organizerCodes.set(json.id, json.organizerCode);
  return { status: res.status, json };
};

describe('poll API', () => {
  it('starts empty and reports healthy', async () => {
    expect((await api('GET', '/api/health')).json.status).toBe('ok');
    expect((await api('GET', '/api/polls')).json).toEqual([]);
  });

  it('rejects a poll without title or dates', async () => {
    expect((await api('POST', '/api/polls', { dates: ['2026-10-01'] })).status).toBe(400);
    expect((await api('POST', '/api/polls', { title: 'x', dates: [] })).status).toBe(400);
  });

  it('walks the full lifecycle: create → respond → finalize → reset → remove', async () => {
    const created = await api('POST', '/api/polls', {
      title: '  Team sync ',
      dates: ['2026-10-02', '2026-10-01', '2026-10-01'],
      durationMinutes: 60,
      timezone: 'Europe/Warsaw',
      creatorName: 'Ada',
    });
    expect(created.status).toBe(201);
    const poll = created.json;
    expect(poll.title).toBe('Team sync');
    expect(poll.dates).toEqual(['2026-10-01', '2026-10-02']); // deduped + sorted
    expect(poll.finalizedSlot).toBeNull();

    // list shows the summary for the ids asked for
    const list = (await api('GET', `/api/polls?ids=${poll.id},poll_missing`)).json;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: poll.id, participantsCount: 0 });

    // respond, then update with the returned edit code → one participant, updated
    const r1 = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Bob',
      availability: { '2026-10-01T10:00': 'available' },
    });
    expect(r1.status).toBe(200);
    expect(r1.json.editCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const r2 = await api(
      'POST',
      `/api/polls/${poll.id}/respond`,
      { name: 'bob', participantId: r1.json.participant.id, availability: { '2026-10-01T10:00': 'preferred' } },
      { headers: { 'X-Edit-Code': r1.json.editCode } }
    );
    expect(r2.json.editCode).toBeUndefined();
    expect(r2.json.poll.participants).toHaveLength(1);
    expect(r2.json.poll.participants[0].availability['2026-10-01T10:00']).toBe('preferred');

    // name is required
    expect((await api('POST', `/api/polls/${poll.id}/respond`, { availability: {} })).status).toBe(400);

    // finalize
    const fin = await api('POST', `/api/polls/${poll.id}/finalize`, {
      date: '2026-10-01',
      startTime: '10:00',
      endTime: '11:00',
    });
    expect(fin.json.finalizedSlot).toMatchObject({ date: '2026-10-01', confirmedBy: 'Ada' });
    expect((await api('GET', `/api/polls/${poll.id}`)).json.finalizedSlot.startTime).toBe('10:00');

    // reset
    expect((await api('POST', `/api/polls/${poll.id}/reset`)).json.finalizedSlot).toBeNull();

    // remove participant
    const pid = r2.json.participant.id;
    const del = await api('DELETE', `/api/polls/${poll.id}/respond/${pid}`);
    expect(del.json.participants).toEqual([]);
  });

  it('stores per-day hours', async () => {
    const res = await api('POST', '/api/polls', {
      title: 'Hours',
      dates: ['2026-11-03', '2026-11-04', '2026-11-05'],
      startHour: 9,
      endHour: 17,
      dayHours: { '2026-11-03': { startHour: 13, endHour: 18 } },
    });
    expect(res.status).toBe(201);
    expect(res.json.dayHours).toEqual({ '2026-11-03': { startHour: 13, endHour: 18 } });

    const half = await api('POST', '/api/polls', {
      title: 'Half',
      dates: ['2026-11-03', '2026-11-04'],
      startHour: 9.5,
      endHour: 12.5,
      dayHours: { '2026-11-04': { startHour: 13, endHour: 14.5 } },
    });
    expect(half.json).toMatchObject({ startHour: 9.5, endHour: 12.5 });
    expect(half.json.dayHours).toEqual({ '2026-11-04': { startHour: 13, endHour: 14.5 } });

    const noHours = await api('POST', '/api/polls', { title: 'Plain', dates: ['2026-11-03'] });
    expect(noHours.json).toMatchObject({ startHour: 9, endHour: 17 });
    expect(noHours.json.dayHours).toBeUndefined();
  });

  it('stores proposed slots with gaps and only accepts answers inside them', async () => {
    const res = await api('POST', '/api/polls', {
      title: 'Gaps',
      dates: ['2026-11-10', '2026-11-11'],
      startHour: 8,
      endHour: 18,
      proposedSlots: {
        '2026-11-10': ['14:00', '09:00', '09:30', '09:30'],
        '2026-11-11': ['12:00'],
      },
    });
    expect(res.status).toBe(201);
    // Sorted, deduped, and the poll-wide window follows the proposal's span.
    expect(res.json.proposedSlots).toEqual({ '2026-11-10': ['09:00', '09:30', '14:00'], '2026-11-11': ['12:00'] });
    expect(res.json).toMatchObject({ startHour: 9, endHour: 14.5 });

    const inGap = await api('POST', `/api/polls/${res.json.id}/respond`, {
      name: 'Hal',
      availability: { '2026-11-10T10:00': 'available' },
    });
    expect(inGap.status).toBe(400);
    const inside = await api('POST', `/api/polls/${res.json.id}/respond`, {
      name: 'Hal',
      availability: { '2026-11-10T14:00': 'available' },
    });
    expect(inside.status).toBe(200);
  });

  it('rejects malformed proposed slots', async () => {
    const post = (proposedSlots: unknown, extra: Record<string, unknown> = {}) =>
      api('POST', '/api/polls', { title: 'Bad', dates: ['2026-11-10', '2026-11-11'], proposedSlots, ...extra });

    expect((await post(['09:00'])).status).toBe(400);
    const missingDay = await post({ '2026-11-10': ['09:00'] });
    expect(missingDay.status).toBe(400);
    expect(missingDay.json.error).toContain('2026-11-11');
    expect((await post({ '2026-11-10': ['09:00'], '2026-11-11': [] })).status).toBe(400);
    expect((await post({ '2026-11-10': ['09:15'], '2026-11-11': ['09:00'] })).status).toBe(400);
    expect((await post({ '2026-11-10': ['24:00'], '2026-11-11': ['09:00'] })).status).toBe(400);
    expect((await post({ '2026-11-10': ['09:00'], '2026-11-11': ['09:00'], '2026-11-12': ['09:00'] })).status).toBe(400);
    const both = await post(
      { '2026-11-10': ['09:00'], '2026-11-11': ['09:00'] },
      { dayHours: { '2026-11-10': { startHour: 9, endHour: 10 } } }
    );
    expect(both.status).toBe(400);
  });

  it('rejects malformed hours instead of silently dropping them', async () => {
    // startHour must precede endHour
    const inverted = await api('POST', '/api/polls', {
      title: 'Inverted',
      dates: ['2026-11-03'],
      startHour: 17,
      endHour: 9,
    });
    expect(inverted.status).toBe(400);
    expect(inverted.json.error).toMatch(/startHour must be before endHour/);

    // hours must land on whole or half hours inside 0-24
    const quarterTop = await api('POST', '/api/polls', {
      title: 'Quarter',
      dates: ['2026-11-03'],
      startHour: 9.25,
    });
    expect(quarterTop.status).toBe(400);
    expect(quarterTop.json.error).toMatch(/startHour/);

    // quarter-hour dayHours -> 400, naming the date
    const quarterDay = await api('POST', '/api/polls', {
      title: 'Quarter day',
      dates: ['2026-11-03', '2026-11-04'],
      dayHours: { '2026-11-04': { startHour: 13, endHour: 14.25 } },
    });
    expect(quarterDay.status).toBe(400);
    expect(quarterDay.json.error).toContain('2026-11-04');

    // inverted dayHours -> 400
    const invertedDay = await api('POST', '/api/polls', {
      title: 'Inverted day',
      dates: ['2026-11-04'],
      dayHours: { '2026-11-04': { startHour: 18, endHour: 13 } },
    });
    expect(invertedDay.status).toBe(400);
    expect(invertedDay.json.error).toContain('2026-11-04');

    // dayHours for a date that is not in the poll -> 400
    const unknownDay = await api('POST', '/api/polls', {
      title: 'Unknown day',
      dates: ['2026-11-03'],
      dayHours: { '2026-12-24': { startHour: 9, endHour: 12 } },
    });
    expect(unknownDay.status).toBe(400);
    expect(unknownDay.json.error).toContain('2026-12-24');
  });

  it('rejects badly formatted dates', async () => {
    const bad = await api('POST', '/api/polls', { title: 'Bad date', dates: ['03/11/2026'] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/YYYY-MM-DD/);
    expect((await api('POST', '/api/polls', { title: 'Bad', dates: ['2026-1-3'] })).status).toBe(400);
    expect((await api('POST', '/api/polls', { title: 'Bad', dates: [20261103] })).status).toBe(400);
  });

  it.each(['2026-02-29', '2026-02-30', '2026-00-10', '2026-13-01', '0000-01-01'])(
    'rejects nonexistent calendar date %s', async (date) => {
      expect((await api('POST', '/api/polls', { title: 'Invalid', dates: [date] })).status).toBe(400);
    }
  );

  it('accepts a real leap day', async () => {
    // The pinned clock's one-year window holds no leap day, so run a server a few months before one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-leap-'));
    const app = createApi(path.join(dir, 'polls.json'), { clock: () => new Date('2027-12-01T12:00:00Z') });
    const local = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = local.address();
    const root = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    try {
      const res = await fetch(`${root}/api/polls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Leap', dates: ['2028-02-29'] }),
      });
      expect(res.status).toBe(201);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects availability outside the proposed date, hours or slot interval without writing', async () => {
    const poll = (await api('POST', '/api/polls', {
      title: 'Bounded', dates: ['2027-04-01', '2027-04-02'], startHour: 9, endHour: 11,
      dayHours: { '2027-04-02': { startHour: 14, endHour: 15 } },
    })).json;
    const before = fs.readFileSync(path.join(tmpDir, 'polls.json'), 'utf-8');
    for (const key of ['2027-04-03T09:00', '2027-04-01T08:30', '2027-04-01T11:00',
      '2027-04-01T09:15', '2027-04-02T09:00', '2027-04-01T99:99']) {
      expect((await api('POST', `/api/polls/${poll.id}/respond`, {
        name: 'Test', availability: { [key]: 'available' },
      })).status, key).toBe(400);
    }
    expect(fs.readFileSync(path.join(tmpDir, 'polls.json'), 'utf-8')).toBe(before);
    expect((await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Test', availability: { '2027-04-02T14:30': 'available' },
    })).status).toBe(200);
  });

  it('does not finalize a meeting outside its proposed hours', async () => {
    const poll = (await api('POST', '/api/polls', {
      title: 'Bounded meeting', dates: ['2027-04-01'],
      dayHours: { '2027-04-01': { startHour: 14, endHour: 15 } },
    })).json;
    for (const [startTime, endTime] of [['09:00', '09:30'], ['14:45', '15:15']]) {
      expect((await api('POST', `/api/polls/${poll.id}/finalize`, {
        date: '2027-04-01', startTime, endTime,
      })).status).toBe(400);
    }
    expect((await api('GET', `/api/polls/${poll.id}`)).json.finalizedSlot).toBeNull();
  });

  it('preserves the confirmed meeting until it is explicitly reopened', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Locked', dates: ['2027-04-01'] })).json;
    const finalize = (startTime: string, endTime: string) => api('POST', `/api/polls/${poll.id}/finalize`, {
      date: '2027-04-01', startTime, endTime,
    });
    expect((await finalize('09:00', '09:30')).status).toBe(200);
    expect((await finalize('10:00', '10:30')).status).toBe(409);
    expect((await api('GET', `/api/polls/${poll.id}`)).json.finalizedSlot.startTime).toBe('09:00');
    expect((await api('POST', `/api/polls/${poll.id}/reset`)).status).toBe(200);
    expect((await finalize('10:00', '10:30')).status).toBe(200);
  });

  it('finalizes only a proposed start with the exact meeting duration', async () => {
    const poll = (await api('POST', '/api/polls', {
      title: 'Exact duration', dates: ['2027-04-01'], durationMinutes: 45,
    })).json;
    for (const [startTime, endTime] of [['09:15', '10:00'], ['09:00', '09:30'], ['09:00', '10:00']]) {
      expect((await api('POST', `/api/polls/${poll.id}/finalize`, {
        date: '2027-04-01', startTime, endTime,
      })).status).toBe(400);
    }
    expect((await api('POST', `/api/polls/${poll.id}/finalize`, {
      date: '2027-04-01', startTime: '09:00', endTime: '09:45',
    })).status).toBe(200);
  });

  it.each([0, 5, 60, '15', {}, -30])('rejects an unsupported slotInterval %j', async (slotInterval) => {
    expect((await api('POST', '/api/polls', {
      title: 'Bad interval', dates: ['2027-04-01'], slotInterval,
    })).status).toBe(400);
  });

  it.each([15, 30])('accepts supported slotInterval %i', async (slotInterval) => {
    const res = await api('POST', '/api/polls', {
      title: 'Good interval', dates: ['2027-04-01'], slotInterval,
    });
    expect(res.status).toBe(201);
    expect(res.json.slotInterval).toBe(slotInterval);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await fetch(base + '/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error).toBeTruthy();
  });

  it('returns 404 for unknown polls', async () => {
    expect((await api('GET', '/api/polls/nope')).status).toBe(404);
    expect((await api('POST', '/api/polls/nope/finalize', { date: 'd', startTime: 's', endTime: 'e' })).status).toBe(404);
  });

  it('validates the finalize payload', async () => {
    const poll = (
      await api('POST', '/api/polls', { title: 'Finalize me', dates: ['2026-12-01', '2026-12-02'], durationMinutes: 60 })
    ).json;
    const finalize = (body: unknown) => api('POST', `/api/polls/${poll.id}/finalize`, body);

    // date must be a well-formed string inside the poll
    expect((await finalize({ date: 20261201, startTime: '10:00', endTime: '11:00' })).status).toBe(400);
    expect((await finalize({ date: '01/12/2026', startTime: '10:00', endTime: '11:00' })).status).toBe(400);
    const outside = await finalize({ date: '2026-12-09', startTime: '10:00', endTime: '11:00' });
    expect(outside.status).toBe(400);
    expect(outside.json.error).toContain('2026-12-09');

    // times must be HH:mm, and ordered
    expect((await finalize({ date: '2026-12-01', startTime: '9:00', endTime: '11:00' })).status).toBe(400);
    expect((await finalize({ date: '2026-12-01', startTime: '10:00', endTime: '25:00' })).status).toBe(400);
    expect((await finalize({ date: '2026-12-01', startTime: '10:00', endTime: 1100 })).status).toBe(400);
    const inverted = await finalize({ date: '2026-12-01', startTime: '11:00', endTime: '10:00' });
    expect(inverted.status).toBe(400);
    expect(inverted.json.error).toMatch(/startTime must be before endTime/);

    // confirmedBy must be a string when present
    expect((await finalize({ date: '2026-12-01', startTime: '10:00', endTime: '11:00', confirmedBy: 7 })).status).toBe(400);

    // and a well-formed payload lands
    const ok = await finalize({ date: '2026-12-02', startTime: '09:30', endTime: '10:30', confirmedBy: 'Ada' });
    expect(ok.status).toBe(200);
    expect(ok.json.finalizedSlot).toMatchObject({
      date: '2026-12-02',
      startTime: '09:30',
      endTime: '10:30',
      confirmedBy: 'Ada',
    });
  });

  it('answers malformed JSON with 400, not 500', async () => {
    const res = await fetch(base + '/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('writes nothing when a mutation 404s', async () => {
    const file = path.join(tmpDir, 'polls.json');
    const before = fs.statSync(file);
    const beforeBody = fs.readFileSync(file, 'utf-8');
    await new Promise((r) => setTimeout(r, 20));

    expect((await api('POST', '/api/polls/nope/reset')).status).toBe(404);
    expect((await api('DELETE', '/api/polls/nope/respond/whoever')).status).toBe(404);

    const after = fs.statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(file, 'utf-8')).toBe(beforeBody);
  });

  it('picks up an out-of-band edit to the data file', async () => {
    const file = path.join(tmpDir, 'polls.json');
    const polls = JSON.parse(fs.readFileSync(file, 'utf-8'));
    polls.push({
      id: 'poll_outofband',
      title: 'Edited on disk',
      description: '',
      location: 'Online Meeting',
      durationMinutes: 30,
      timezone: 'UTC',
      dates: ['2027-01-04'],
      startHour: 9,
      endHour: 17,
      slotInterval: 30,
      creatorName: 'Someone else',
      creatorEmail: '',
      createdAt: new Date().toISOString(),
      finalizedSlot: null,
      participants: [],
      organizerCodeHash: 'a'.repeat(64),
    });
    fs.writeFileSync(file, JSON.stringify(polls, null, 2), 'utf-8');

    const fetched = await api('GET', '/api/polls/poll_outofband');
    expect(fetched.status).toBe(200);
    expect(fetched.json.title).toBe('Edited on disk');
    expect(fetched.json.organizerCodeHash).toBeUndefined();
    expect((await api('GET', '/api/polls?ids=poll_outofband')).json.some((p: { id: string }) => p.id === 'poll_outofband')).toBe(true);
  });

  it('rejects an unknown participantId and never matches responses by name', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Dedupe', dates: ['2027-02-01'] })).json;

    const first = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Cara',
      availability: { '2027-02-01T10:00': 'available' },
    });
    const realId = first.json.participant.id;

    // A stale id must not silently overwrite whoever shares the name.
    const stale = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: '  cara ',
      participantId: 'part_stale',
      availability: { '2027-02-01T10:00': 'preferred' },
    });
    expect(stale.status).toBe(404);
    expect(stale.json.error).toBe('Participant not found');

    // The known id updates in place with its edit code.
    const known = await api(
      'POST',
      `/api/polls/${poll.id}/respond`,
      { name: 'Cara', participantId: realId, availability: { '2027-02-01T10:00': 'preferred' } },
      { headers: { 'X-Edit-Code': first.json.editCode } }
    );
    expect(known.json.poll.participants).toHaveLength(1);
    expect(known.json.participant.availability['2027-02-01T10:00']).toBe('preferred');

    // Without an id, a new name gets a server id.
    const third = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Dan', availability: {} });
    expect(third.json.poll.participants).toHaveLength(2);
    expect(third.json.participant.id).toMatch(/^part_/);
  });

  it('requires optional fields to be strings', async () => {
    for (const field of ['description', 'location', 'creatorName', 'creatorEmail', 'timezone']) {
      const res = await api('POST', '/api/polls', {
        title: 'Types',
        dates: ['2027-03-01'],
        [field]: 42,
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain(field);
    }
    expect((await api('POST', '/api/polls', { title: 42, dates: ['2027-03-01'] })).status).toBe(400);
    expect((await api('POST', '/api/polls', { title: '   ', dates: ['2027-03-01'] })).status).toBe(400);
  });

  it('bounds durationMinutes', async () => {
    const create = (durationMinutes: unknown) =>
      api('POST', '/api/polls', { title: 'Duration', dates: ['2027-03-02'], durationMinutes });
    expect((await create(0)).status).toBe(400);
    expect((await create(-30)).status).toBe(400);
    expect((await create(45.5)).status).toBe(400);
    expect((await create(481)).status).toBe(400);
    expect((await create('60')).status).toBe(400);
    expect((await create(480)).json.durationMinutes).toBe(480);
    const defaulted = await api('POST', '/api/polls', { title: 'Default', dates: ['2027-03-02'] });
    expect(defaulted.json.durationMinutes).toBe(30);
  });

  it('rejects malformed availability payloads', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Avail', dates: ['2027-04-01'] })).json;
    const respond = (availability: unknown) =>
      api('POST', `/api/polls/${poll.id}/respond`, { name: 'Eve', availability });

    expect((await respond('busy')).status).toBe(400);
    expect((await respond(['available'])).status).toBe(400);
    expect((await respond({ '2027-04-01T10:00': 'maybe' })).status).toBe(400);
    expect((await respond({ '2027-04-01 10:00': 'available' })).status).toBe(400);
    expect((await respond({ '2027-04-01T10:00': 7 })).status).toBe(400);
    expect((await respond({ '2027-04-01T10:00': 'if_needed' })).status).toBe(200);

    // email and timezone must be strings when present
    expect(
      (await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Eve', email: 5 })).status
    ).toBe(400);
    expect(
      (await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Eve', timezone: {} })).status
    ).toBe(400);
  });

  it('404s a DELETE for an unknown participant without writing', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Delete', dates: ['2027-05-01'] })).json;
    await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Finn', availability: {} });

    const file = path.join(tmpDir, 'polls.json');
    const before = fs.statSync(file);
    const beforeBody = fs.readFileSync(file, 'utf-8');
    await new Promise((r) => setTimeout(r, 20));

    const res = await api('DELETE', `/api/polls/${poll.id}/respond/part_missing`);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Participant not found');
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(file, 'utf-8')).toBe(beforeBody);
  });

  it('rejects past dates on create, with one day of slack for time zones', async () => {
    // Clock is 2026-09-13: 2026-09-12 is still allowed, 2026-09-11 is not.
    const past = await api('POST', '/api/polls', { title: 'Too old', dates: ['2026-09-11', '2026-10-01'] });
    expect(past.status).toBe(400);
    expect(past.json).toEqual({ error: '2026-09-11 is in the past.' });
    expect((await api('POST', '/api/polls', { title: 'Long gone', dates: ['2026-08-01'] })).json.error)
      .toBe('2026-08-01 is in the past.');
    expect((await api('POST', '/api/polls', { title: 'Yesterday', dates: ['2026-09-12'] })).status).toBe(201);
  });

  it('accepts a valid IANA time zone, rejects an unknown one and defaults an absent one', async () => {
    const valid = await api('POST', '/api/polls', { title: 'Zoned', dates: ['2026-10-01'], timezone: 'Europe/Warsaw' });
    expect(valid.status).toBe(201);
    expect(valid.json.timezone).toBe('Europe/Warsaw');

    for (const timezone of ['Mars/Olympus_Mons', 'not a zone', 'Europe/Warsaw; drop']) {
      const invalid = await api('POST', '/api/polls', { title: 'Zoned', dates: ['2026-10-01'], timezone });
      expect(invalid.status, timezone).toBe(400);
      expect(invalid.json).toEqual({ error: 'timezone must be a valid IANA time zone, e.g. Europe/Warsaw.' });
    }

    const absent = await api('POST', '/api/polls', { title: 'Zoneless', dates: ['2026-10-01'] });
    expect(absent.status).toBe(201);
    expect(absent.json.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  });

  it('adds dates in the default window without changing the poll format or answers', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Extend', dates: ['2026-10-05'], startHour: 9, endHour: 10 })).json;
    await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Jo', availability: { '2026-10-05T09:00': 'available' } });

    const res = await api('POST', `/api/polls/${poll.id}/dates`, {
      dates: ['2026-10-07', '2026-10-06'],
      proposedSlots: { '2026-10-06': ['09:00', '09:30'], '2026-10-07': ['09:30', '09:00'] },
    });
    expect(res.status).toBe(200);
    expect(res.json.dates).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(res.json.proposedSlots).toBeUndefined();
    expect(res.json.participants[0].availability).toEqual({ '2026-10-05T09:00': 'available' });

    // The new day is immediately answerable.
    const answer = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Jo',
      availability: { '2026-10-05T09:00': 'available', '2026-10-07T09:30': 'preferred' },
    });
    expect(answer.status).toBe(200);
  });

  it('switches to exact slots when new dates differ, freezing existing dates as they were', async () => {
    const poll = (
      await api('POST', '/api/polls', {
        title: 'Freeze',
        dates: ['2026-10-05', '2026-10-06'],
        startHour: 9,
        endHour: 10,
        dayHours: { '2026-10-06': { startHour: 13, endHour: 14 } },
      })
    ).json;

    const res = await api('POST', `/api/polls/${poll.id}/dates`, {
      dates: ['2026-10-08'],
      proposedSlots: { '2026-10-08': ['16:00'] },
    });
    expect(res.status).toBe(200);
    expect(res.json.proposedSlots).toEqual({
      '2026-10-05': ['09:00', '09:30'],
      '2026-10-06': ['13:00', '13:30'],
      '2026-10-08': ['16:00'],
    });
    expect(res.json.dayHours).toBeUndefined();
    expect(res.json).toMatchObject({ startHour: 9, endHour: 16.5 });
  });

  it('rejects bad extensions', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Guarded', dates: ['2026-10-05'] })).json;
    const add = (body: unknown) => api('POST', `/api/polls/${poll.id}/dates`, body);

    expect((await add({})).status).toBe(400);
    expect((await add({ dates: ['2026-13-01'], proposedSlots: {} })).status).toBe(400);
    const duplicate = await add({ dates: ['2026-10-05'], proposedSlots: { '2026-10-05': ['09:00'] } });
    expect(duplicate.status).toBe(400);
    expect(duplicate.json.error).toMatch(/already/);
    // Clock is 2026-09-13; one day of slack for timezones.
    expect((await add({ dates: ['2026-09-11'], proposedSlots: { '2026-09-11': ['09:00'] } })).status).toBe(400);
    expect((await add({ dates: ['2026-09-12'], proposedSlots: { '2026-09-12': ['09:00'] } })).status).toBe(200);
    expect((await add({ dates: ['2026-10-20'], proposedSlots: { '2026-10-20': [] } })).status).toBe(400);
    expect((await add({ dates: ['2026-10-21'] })).status).toBe(400);
    expect((await api('POST', '/api/polls/nope/dates', { dates: ['2026-10-22'], proposedSlots: { '2026-10-22': ['09:00'] } })).status).toBe(404);

    await api('POST', `/api/polls/${poll.id}/finalize`, { date: '2026-10-05', startTime: '09:00', endTime: '09:30' });
    const locked = await add({ dates: ['2026-10-23'], proposedSlots: { '2026-10-23': ['09:00'] } });
    expect(locked.status).toBe(409);
  });

  it('deletes a poll, and 404s an unknown one', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Doomed', dates: ['2027-05-02'] })).json;
    await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Gus', availability: {} });

    const del = await api('DELETE', `/api/polls/${poll.id}`);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ id: poll.id });
    expect((await api('GET', `/api/polls/${poll.id}`)).status).toBe(404);
    expect((await api('GET', '/api/polls')).json.some((p: { id: string }) => p.id === poll.id)).toBe(false);

    const again = await api('DELETE', `/api/polls/${poll.id}`);
    expect(again.status).toBe(404);
    expect(again.json.error).toBe('Poll not found');
  });

  it('accepts 24:00 as an end time', async () => {
    const poll = (
      await api('POST', '/api/polls', {
        title: 'Late',
        dates: ['2027-06-01'],
        startHour: 22,
        endHour: 24,
      })
    ).json;

    const ok = await api('POST', `/api/polls/${poll.id}/finalize`, {
      date: '2027-06-01',
      startTime: '23:30',
      endTime: '24:00',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.finalizedSlot).toMatchObject({ startTime: '23:30', endTime: '24:00' });

    // 24:00 is an end marker only: nothing may start there, and 24:30 is not a time.
    expect(
      (await api('POST', `/api/polls/${poll.id}/finalize`, {
        date: '2027-06-01',
        startTime: '24:00',
        endTime: '24:00',
      })).status
    ).toBe(400);
    expect(
      (await api('POST', `/api/polls/${poll.id}/finalize`, {
        date: '2027-06-01',
        startTime: '23:00',
        endTime: '24:30',
      })).status
    ).toBe(400);
  });

  it.each(['{ damaged JSON', '{"not":"an array"}'])(
    'fails closed and preserves a corrupt store: %s', async (corrupt) => {
      const file = path.join(tmpDir, 'polls.json');
      const original = fs.readFileSync(file, 'utf-8');
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        fs.writeFileSync(file, corrupt);
        expect((await api('GET', '/api/polls?ids=poll_x')).status).toBe(500);
        expect((await api('POST', '/api/polls', { title: 'Must not overwrite', dates: ['2027-01-01'] })).status).toBe(500);
        expect(fs.readFileSync(file, 'utf-8')).toBe(corrupt);
      } finally {
        fs.writeFileSync(file, original);
        errorLog.mockRestore();
      }
      expect((await api('GET', '/api/polls?ids=poll_x')).status).toBe(200);
    }
  );
});

describe('poll API retention', () => {
  it('hides and then deletes polls once their last date is past the retention window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-retention-'));
    const file = path.join(dir, 'polls.json');
    let now = new Date('2026-09-13T12:00:00Z');
    const app = createApi(file, { clock: () => now, rateLimit: false });
    const local = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = local.address();
    const root = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(root + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };

    try {
      const short = (await call('POST', '/api/polls', { title: 'Short', dates: ['2026-09-20'] })).json;
      const long = (await call('POST', '/api/polls', { title: 'Long', dates: ['2026-09-20', '2026-11-01'] })).json;

      now = new Date('2026-10-04T23:59:00Z'); // 14 days after 2026-09-20: still kept
      expect((await call('GET', `/api/polls/${short.id}`)).status).toBe(200);

      now = new Date('2026-10-05T00:00:00Z'); // 15th day: gone from reads
      expect((await call('GET', `/api/polls/${short.id}`)).status).toBe(404);
      expect((await call('GET', `/api/polls?ids=${short.id},${long.id}`)).json.map((p: { id: string }) => p.id)).toEqual([long.id]);
      // Reads and writes to other polls leave it alone; a write aimed at it removes it.
      expect(fs.readFileSync(file, 'utf-8')).toContain(short.id);
      await call('POST', `/api/polls/${long.id}/respond`, { name: 'Ivy', availability: {} });
      expect(fs.readFileSync(file, 'utf-8')).toContain(short.id);
      expect((await call('POST', `/api/polls/${short.id}/respond`, { name: 'Ivy', availability: {} })).status).toBe(404);
      expect(fs.readFileSync(file, 'utf-8')).not.toContain(short.id);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Input limits (pinned clock 2026-09-13: latest allowed date is 2027-09-14) ───
describe('poll API input limits', () => {
  const datesFrom = (start: string, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const day = new Date(`${start}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + i);
      return day.toISOString().slice(0, 10);
    });

  it('accepts dates up to one year ahead and rejects later ones', async () => {
    expect((await api('POST', '/api/polls', { title: 'Edge', dates: ['2027-09-14'] })).status).toBe(201);
    const far = await api('POST', '/api/polls', { title: 'Far', dates: ['2026-10-01', '2027-09-15'] });
    expect(far.status).toBe(400);
    expect(far.json.error).toMatch(/2027-09-15 is too far ahead/);
    expect((await api('POST', '/api/polls', { title: 'Year 9999', dates: ['9999-01-01'] })).status).toBe(400);
  });

  it('caps the number of dates on create and when adding dates', async () => {
    const tooMany = await api('POST', '/api/polls', { title: 'Many', dates: datesFrom('2026-10-01', 61) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error).toMatch(/at most 60 dates/);

    const full = await api('POST', '/api/polls', { title: 'Full', dates: datesFrom('2026-10-01', 60) });
    expect(full.status).toBe(201);
    const extra = await api('POST', `/api/polls/${full.json.id}/dates`, {
      dates: ['2027-01-15'],
      proposedSlots: { '2027-01-15': ['09:00'] },
    });
    expect(extra.status).toBe(400);
    expect(extra.json.error).toMatch(/at most 60 dates/);
  });

  it('rejects over-long text fields', async () => {
    const title = await api('POST', '/api/polls', { title: 'x'.repeat(121), dates: ['2026-10-01'] });
    expect(title.status).toBe(400);
    expect(title.json.error).toBe('title must be at most 120 characters.');
    const description = await api('POST', '/api/polls', {
      title: 'Ok', description: 'x'.repeat(1001), dates: ['2026-10-01'],
    });
    expect(description.status).toBe(400);

    const poll = (await api('POST', '/api/polls', { title: 'Names', dates: ['2026-10-01'] })).json;
    const name = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'n'.repeat(81), availability: {} });
    expect(name.status).toBe(400);
    expect(name.json.error).toBe('name must be at most 80 characters.');
  });

  it('rejects an oversized request body with a JSON 413', async () => {
    const res = await fetch(`${base}/api/polls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Huge', dates: ['2026-10-01'], description: 'x'.repeat(300_000) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toHaveProperty('error');
  });

  it('caps responses per poll but still lets existing participants update', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Crowd', dates: ['2026-10-01'] })).json;
    let first: { participant: { id: string }; editCode: string } | undefined;
    for (let i = 0; i < 200; i++) {
      const saved = await api('POST', `/api/polls/${poll.id}/respond`, { name: `P${i}`, availability: {} });
      expect(saved.status).toBe(200);
      first ??= saved.json;
    }
    const extra = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Late', availability: {} });
    expect(extra.status).toBe(409);
    expect(extra.json.error).toMatch(/limit of 200 responses/);
    const update = await api(
      'POST',
      `/api/polls/${poll.id}/respond`,
      { name: 'P0', participantId: first!.participant.id, availability: { '2026-10-01T09:00': 'available' } },
      { headers: { 'X-Edit-Code': first!.editCode } }
    );
    expect(update.status).toBe(200);
  }, 30_000);
});

// ─── Authorization ───
describe('poll API authorization', () => {
  const create = async () => {
    const created = await api('POST', '/api/polls', {
      title: 'Private', dates: ['2026-10-01'], durationMinutes: 30, creatorEmail: 'ada@example.com',
    });
    expect(created.json.organizerCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.json.organizerCodeHash).toBeUndefined();
    return created.json as { id: string; organizerCode: string };
  };

  it('lists nothing without ids and caps how many ids one request may ask for', async () => {
    await create();
    expect((await api('GET', '/api/polls')).json).toEqual([]);
    const tooMany = Array.from({ length: 51 }, (_, i) => `poll_${i}`).join(',');
    expect((await api('GET', `/api/polls?ids=${tooMany}`)).status).toBe(400);
  });

  it.each([
    ['DELETE', ''],
    ['POST', '/finalize', { date: '2026-10-01', startTime: '09:00', endTime: '09:30' }],
    ['POST', '/reset'],
    ['POST', '/dates', { dates: ['2026-10-02'], proposedSlots: { '2026-10-02': ['09:00'] } }],
  ] as const)('forbids %s %s without the organizer code and with a wrong one', async (method, suffix, body?) => {
    const poll = await create();
    const other = await create();
    const url = `/api/polls/${poll.id}${suffix}`;
    const attempts: Record<string, string>[] = [{}, { 'X-Organizer-Code': 'wrong' }, { 'X-Organizer-Code': other.organizerCode }];
    for (const headers of attempts) {
      const res = await api(method, url, body, { guest: true, headers });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/Only the organizer/);
    }
    expect((await api('GET', `/api/polls/${poll.id}`)).status).toBe(200);
    expect((await api(method, url, body)).status).toBe(200);
  });

  it('forbids removing a response without the organizer code', async () => {
    const poll = await create();
    const saved = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Bob', availability: {} });
    const url = `/api/polls/${poll.id}/respond/${saved.json.participant.id}`;
    const byParticipant = await api('DELETE', url, undefined, { guest: true, headers: { 'X-Edit-Code': saved.json.editCode } });
    expect(byParticipant.status).toBe(403);
    expect((await api('DELETE', url)).json.participants).toEqual([]);
  });

  it('lets only the edit code or the organizer update a response; same name makes a new one', async () => {
    const poll = await create();
    const saved = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Bob', email: 'bob@example.com', availability: { '2026-10-01T09:00': 'available' },
    });
    const participantId = saved.json.participant.id;
    const update = (headers: Record<string, string>) =>
      api('POST', `/api/polls/${poll.id}/respond`,
        { name: 'Mallory', participantId, availability: {} }, { guest: true, headers });

    expect((await update({})).status).toBe(403);
    expect((await update({ 'X-Edit-Code': 'guess' })).status).toBe(403);
    expect((await update({ 'X-Organizer-Code': 'guess' })).status).toBe(403);
    expect((await update({ 'X-Edit-Code': saved.json.editCode })).status).toBe(200);
    expect((await update({ 'X-Organizer-Code': poll.organizerCode })).status).toBe(200);

    const sameName = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Mallory', availability: {} });
    expect(sameName.json.poll.participants).toHaveLength(2);
  });

  it('shows emails only to the organizer and never exposes code hashes', async () => {
    const poll = await create();
    await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Bob', email: 'bob@example.com', availability: {} });

    const guest = (await api('GET', `/api/polls/${poll.id}`, undefined, { guest: true })).json;
    expect(guest.creatorEmail).toBeUndefined();
    expect(guest.participants[0].email).toBeUndefined();
    expect(JSON.stringify(guest)).not.toMatch(/CodeHash/);

    const organizer = (await api('GET', `/api/polls/${poll.id}`)).json;
    expect(organizer.creatorEmail).toBe('ada@example.com');
    expect(organizer.participants[0].email).toBe('bob@example.com');
    expect(JSON.stringify(organizer)).not.toMatch(/CodeHash/);
  });

  it('reports whether a presented organizer code unlocks the poll', async () => {
    const poll = await create();
    expect((await api('GET', `/api/polls/${poll.id}/access`, undefined, { guest: true })).json).toEqual({ organizer: false });
    expect((await api('GET', `/api/polls/${poll.id}/access`)).json).toEqual({ organizer: true });
    expect((await api('GET', '/api/polls/poll_missing/access')).status).toBe(404);
  });

  it('rejects non-JSON mutations, which browsers can send cross-site without a preflight', async () => {
    const poll = await create();
    const res = await fetch(`${base}/api/polls/${poll.id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'Cross site', availability: {} }),
    });
    expect(res.status).toBe(415);

    // A bodiless POST without a Content-Type, as the browser sends for reset, is fine.
    const reset = await fetch(`${base}/api/polls/${poll.id}/reset`, {
      method: 'POST',
      headers: { 'X-Organizer-Code': poll.organizerCode },
    });
    expect(reset.status).toBe(200);
  });

  it('retires stored polls that were created before organizer codes existed', async () => {
    const file = path.join(tmpDir, 'polls.json');
    const polls = JSON.parse(fs.readFileSync(file, 'utf-8'));
    polls.push({ ...polls[0], id: 'poll_legacy', organizerCodeHash: undefined });
    fs.writeFileSync(file, JSON.stringify(polls, null, 2), 'utf-8');

    expect((await api('GET', '/api/polls/poll_legacy')).status).toBe(404);
    // A write aimed at it deletes it; the daily sweep covers untouched ones.
    expect((await api('POST', '/api/polls/poll_legacy/respond', { name: 'Late', availability: {} })).status).toBe(404);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('poll_legacy');
  });
});

// ─── Responses: idempotent first saves, stored fields, locked voting ───
describe('poll API responses', () => {
  const clientCode = (seed: string) => seed.repeat(40).slice(0, 40);

  it('uses unguessable base64url ids for polls and participants', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Ids', dates: ['2026-10-01'] })).json;
    expect(poll.id).toMatch(/^poll_[A-Za-z0-9_-]{22}$/);
    const saved = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Ida', availability: {} });
    expect(saved.json.participant.id).toMatch(/^part_[A-Za-z0-9_-]{22}$/);
  });

  it('makes a first save with a client edit code idempotent when the request is replayed', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Replay', dates: ['2026-10-01'] })).json;
    const code = clientCode('Ab9_-');
    const save = (availability: Record<string, string>) => api(
      'POST', `/api/polls/${poll.id}/respond`, { name: 'Rex', availability }, { headers: { 'X-Edit-Code': code } }
    );

    const first = await save({ '2026-10-01T09:00': 'available' });
    expect(first.status).toBe(200);
    expect(first.json.editCode).toBe(code);
    const replay = await save({ '2026-10-01T09:00': 'preferred' });
    expect(replay.status).toBe(200);
    expect(replay.json.editCode).toBe(code);
    expect(replay.json.participant.id).toBe(first.json.participant.id);
    expect(replay.json.poll.participants).toHaveLength(1);
    expect(replay.json.participant.availability['2026-10-01T09:00']).toBe('preferred');

    // The client code then works for normal updates.
    const update = await api('POST', `/api/polls/${poll.id}/respond`,
      { name: 'Rex', participantId: first.json.participant.id, availability: {} }, { headers: { 'X-Edit-Code': code } });
    expect(update.status).toBe(200);
    expect(update.json.editCode).toBeUndefined();
  });

  it('keeps concurrent replays of one first save to a single response', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Burst', dates: ['2026-10-01'] })).json;
    const code = clientCode('burst');
    const saves = await Promise.all(Array.from({ length: 6 }, () => api(
      'POST', `/api/polls/${poll.id}/respond`, { name: 'Bea', availability: {} }, { headers: { 'X-Edit-Code': code } }
    )));
    expect(saves.every((save) => save.status === 200)).toBe(true);
    expect((await api('GET', `/api/polls/${poll.id}`)).json.participants).toHaveLength(1);
  });

  it.each([
    ['too short', 'a'.repeat(31)],
    ['too long', 'a'.repeat(129)],
    ['bad characters', `${'a'.repeat(32)}!`],
  ])('rejects a client edit code that is %s', async (_label, code) => {
    const poll = (await api('POST', '/api/polls', { title: 'Codes', dates: ['2026-10-01'] })).json;
    const res = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Cy', availability: {} }, { headers: { 'X-Edit-Code': code } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/X-Edit-Code/);
    expect((await api('GET', `/api/polls/${poll.id}`)).json.participants).toHaveLength(0);
  });

  it('keeps the stored email and timezone when an update leaves them out', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Fields', dates: ['2026-10-01'], timezone: 'UTC' })).json;
    const first = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Eli', email: 'eli@example.com', timezone: 'Europe/Warsaw', availability: {},
    });
    const participantId = first.json.participant.id;
    const update = (body: Record<string, unknown>) => api('POST', `/api/polls/${poll.id}/respond`,
      { name: 'Eli', participantId, availability: {}, ...body }, { headers: { 'X-Edit-Code': first.json.editCode } });
    const stored = async () => (await api('GET', `/api/polls/${poll.id}`)).json.participants[0];

    expect((await update({})).status).toBe(200);
    expect(await stored()).toMatchObject({ email: 'eli@example.com', timezone: 'Europe/Warsaw' });

    await update({ email: 'new@example.com', timezone: 'America/New_York' });
    expect(await stored()).toMatchObject({ email: 'new@example.com', timezone: 'America/New_York' });

    // An explicit empty email clears it.
    await update({ email: '' });
    const cleared = await stored();
    expect(cleared.email).toBeUndefined();
    expect(cleared.timezone).toBe('America/New_York');
  });

  it('closes voting once a time is locked, but the organizer can still remove a response', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Closed', dates: ['2026-10-01'] })).json;
    const saved = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Gil', availability: {} });
    await api('POST', `/api/polls/${poll.id}/finalize`, { date: '2026-10-01', startTime: '09:00', endTime: '09:30' });

    const closed = 'Voting is closed. The organizer must re-open voting before answers can change.';
    const fresh = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Late', availability: {} });
    expect(fresh.status).toBe(409);
    expect(fresh.json).toEqual({ error: closed });
    const update = await api('POST', `/api/polls/${poll.id}/respond`,
      { name: 'Gil', participantId: saved.json.participant.id, availability: {} },
      { headers: { 'X-Edit-Code': saved.json.editCode } });
    expect(update.status).toBe(409);
    const byOrganizer = await api('POST', `/api/polls/${poll.id}/respond`,
      { name: 'Gil', participantId: saved.json.participant.id, availability: {} },
      { headers: { 'X-Organizer-Code': poll.organizerCode } });
    expect(byOrganizer.status).toBe(409);

    const removed = await api('DELETE', `/api/polls/${poll.id}/respond/${saved.json.participant.id}`);
    expect(removed.status).toBe(200);
    expect(removed.json.participants).toEqual([]);
  });

  it('caps availability entries per response', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Cap', dates: ['2026-10-01'] })).json;
    const availability = Object.fromEntries(Array.from({ length: MAX_AVAILABILITY_ENTRIES + 1 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 9, 1) + i * 15 * 60_000);
      return [day.toISOString().slice(0, 16), 'available'];
    }));
    const res = await api('POST', `/api/polls/${poll.id}/respond`, { name: 'Max', availability });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(`availability may list at most ${MAX_AVAILABILITY_ENTRIES} slots.`);
  });

  it('refuses a save that would grow one stored poll past the size limit', async () => {
    const poll = (await api('POST', '/api/polls', { title: 'Heavy', dates: ['2026-10-01'] })).json;
    const file = path.join(tmpDir, 'polls.json');
    const polls = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const stored = polls.find((p: { id: string }) => p.id === poll.id);
    // Corrupt or hand-edited storage: normal use cannot get a poll this close to the limit.
    stored.description = 'x'.repeat(MAX_POLL_BYTES - 200);
    fs.writeFileSync(file, JSON.stringify(polls, null, 2), 'utf-8');

    const res = await api('POST', `/api/polls/${poll.id}/respond`, {
      name: 'Heavy', email: 'e'.repeat(160), timezone: 't'.repeat(64),
      availability: Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
        [`2026-10-01T${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, 'available'])),
    });
    expect(res.status).toBe(413);
    expect(res.json.error).toMatch(/storage limit of 2 MB/);
    expect((await api('GET', `/api/polls/${poll.id}`)).json.participants).toHaveLength(0);
  });
});

// ─── Meeting-length fit ───
describe('poll API meeting-length fit', () => {
  it('rejects a created poll whose date has no back-to-back run long enough for the meeting', async () => {
    const gaps = await api('POST', '/api/polls', {
      title: 'Gappy', dates: ['2026-10-01', '2026-10-02'], durationMinutes: 60,
      proposedSlots: { '2026-10-01': ['09:00', '09:30'], '2026-10-02': ['09:00', '10:00'] },
    });
    expect(gaps.status).toBe(400);
    expect(gaps.json.error).toBe('2026-10-02 has no 60-minute run of proposed times.');

    const shortDay = await api('POST', '/api/polls', {
      title: 'Short day', dates: ['2026-10-01'], durationMinutes: 90, startHour: 9, endHour: 10,
    });
    expect(shortDay.status).toBe(400);
    expect(shortDay.json.error).toBe('2026-10-01 has no 90-minute run of proposed times.');

    const fits = await api('POST', '/api/polls', {
      title: 'Fits', dates: ['2026-10-01'], durationMinutes: 60,
      proposedSlots: { '2026-10-01': ['09:00', '11:00', '11:30'] },
    });
    expect(fits.status).toBe(201);
  });

  it('checks only the new dates when adding dates', async () => {
    const poll = (await api('POST', '/api/polls', {
      title: 'Extend fit', dates: ['2026-10-01'], durationMinutes: 60, startHour: 9, endHour: 11,
    })).json;
    const tooShort = await api('POST', `/api/polls/${poll.id}/dates`, {
      dates: ['2026-10-02', '2026-10-03'],
      proposedSlots: { '2026-10-02': ['09:00', '09:30'], '2026-10-03': ['14:00'] },
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.json.error).toBe('2026-10-03 has no 60-minute run of proposed times.');
    expect((await api('GET', `/api/polls/${poll.id}`)).json.dates).toEqual(['2026-10-01']);

    const ok = await api('POST', `/api/polls/${poll.id}/dates`, {
      dates: ['2026-10-02'], proposedSlots: { '2026-10-02': ['14:00', '14:30'] },
    });
    expect(ok.status).toBe(200);
  });
});

// ─── Rate limits ───
describe('poll API rate limits', () => {
  const serve = async (options: Parameters<typeof createApi>[1]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-limits-'));
    const app = createApi(path.join(dir, 'polls.json'), { clock: () => new Date('2026-09-13T12:00:00Z'), ...options });
    const local = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = local.address();
    const root = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(root + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, retryAfter: res.headers.get('retry-after'), json: await res.json() };
    };
    const close = async () => {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { call, close };
  };

  it('limits poll creation separately from other writes and never limits reads', async () => {
    const { call, close } = await serve({
      rateLimit: { create: { limit: 2, windowMs: 60_000 }, write: { limit: 3, windowMs: 60_000 } },
    });
    try {
      const body = { title: 'Limited', dates: ['2026-10-01'] };
      const first = await call('POST', '/api/polls', body);
      expect(first.status).toBe(201);
      expect((await call('POST', '/api/polls', {})).status).toBe(400); // rejected attempts count too
      const blocked = await call('POST', '/api/polls', body);
      expect(blocked.status).toBe(429);
      expect(blocked.json).toEqual({ error: expect.any(String) });
      expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
      expect(Number(blocked.retryAfter)).toBeLessThanOrEqual(60);

      const id = first.json.id;
      for (let i = 0; i < 5; i++) expect((await call('GET', `/api/polls/${id}`)).status).toBe(200);
      for (let i = 0; i < 3; i++) {
        expect((await call('POST', `/api/polls/${id}/respond`, { name: `W${i}`, availability: {} })).status).toBe(200);
      }
      const writeBlocked = await call('POST', `/api/polls/${id}/respond`, { name: 'W3', availability: {} });
      expect(writeBlocked.status).toBe(429);
      expect(writeBlocked.retryAfter).toBeTruthy();
      expect((await call('DELETE', `/api/polls/${id}`, undefined, { 'X-Organizer-Code': first.json.organizerCode })).status).toBe(429);
    } finally {
      await close();
    }
  });

  it('does not let a spoofed X-Forwarded-For header reset the limit', async () => {
    const { call, close } = await serve({ rateLimit: { create: { limit: 1, windowMs: 60_000 } } });
    try {
      const body = { title: 'Spoof', dates: ['2026-10-01'] };
      expect((await call('POST', '/api/polls', body, { 'X-Forwarded-For': '203.0.113.1' })).status).toBe(201);
      expect((await call('POST', '/api/polls', body, { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(429);
    } finally {
      await close();
    }
  });

  it('counts each client separately and opens a new window once the old one ends', async () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ create: { limit: 1, windowMs: 60_000 } }, () => now);
    const { call, close } = await serve({ rateLimit: limiter, clientIp: (req) => String(req.headers['x-test-client']) });
    try {
      const body = { title: 'Clients', dates: ['2026-10-01'] };
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': 'a' })).status).toBe(201);
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': 'b' })).status).toBe(201);
      const blocked = await call('POST', '/api/polls', body, { 'X-Test-Client': 'a' });
      expect(blocked.status).toBe(429);
      expect(blocked.retryAfter).toBe('60');
      now += 45_000;
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': 'a' })).retryAfter).toBe('15');
      now += 15_000;
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': 'a' })).status).toBe(201);
    } finally {
      await close();
    }
  });

  it('applies the default limits: 60 polls an hour and 600 other writes per 10 minutes', async () => {
    expect(DEFAULT_RATE_LIMITS).toEqual({
      create: { limit: 60, windowMs: 3_600_000 },
      write: { limit: 600, windowMs: 600_000 },
    });
    const { call, close } = await serve({});
    try {
      const body = { title: 'Default', dates: ['2026-10-01'] };
      for (let i = 0; i < 60; i++) expect((await call('POST', '/api/polls', body)).status).toBe(201);
      expect((await call('POST', '/api/polls', body)).status).toBe(429);
    } finally {
      await close();
    }
  });

  it('reads limits from the environment and ignores unusable values', async () => {
    expect(rateLimitsFromEnv({})).toEqual({});
    expect(rateLimitsFromEnv({ RATE_LIMIT_CREATE_PER_HOUR: '5', RATE_LIMIT_WRITES_PER_10_MIN: '0' })).toEqual({
      create: { limit: 5, windowMs: 3_600_000 },
      write: false,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(rateLimitsFromEnv({ RATE_LIMIT_CREATE_PER_HOUR: 'lots', RATE_LIMIT_WRITES_PER_10_MIN: '-1' })).toEqual({});
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }

    const { call, close } = await serve({ rateLimit: rateLimitsFromEnv({ RATE_LIMIT_CREATE_PER_HOUR: '1' }) });
    try {
      const body = { title: 'From env', dates: ['2026-10-01'] };
      expect((await call('POST', '/api/polls', body)).status).toBe(201);
      expect((await call('POST', '/api/polls', body)).status).toBe(429);
    } finally {
      await close();
    }
  });

  it('parses TRUST_PROXY for Express, off by default', () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv('')).toBe(false);
    expect(trustProxyFromEnv('false')).toBe(false);
    expect(trustProxyFromEnv('true')).toBe(true);
    expect(trustProxyFromEnv('1')).toBe(1);
    expect(trustProxyFromEnv('2')).toBe(2);
    expect(trustProxyFromEnv('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });

  it('keys clients by X-Forwarded-For only when trust proxy is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-proxy-'));
    const app = createApi(path.join(dir, 'polls.json'), {
      clock: () => new Date('2026-09-13T12:00:00Z'),
      rateLimit: { create: { limit: 1, windowMs: 60_000 } },
    });
    app.set('trust proxy', trustProxyFromEnv('loopback'));
    const local = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = local.address();
    const root = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    const create = (forwardedFor: string) => fetch(`${root}/api/polls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
      body: JSON.stringify({ title: 'Proxied', dates: ['2026-10-01'] }),
    });
    try {
      expect((await create('203.0.113.1')).status).toBe(201);
      expect((await create('203.0.113.2')).status).toBe(201);
      expect((await create('203.0.113.1')).status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('groups IPv6 clients by their /64 network', async () => {
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(clientKey('2001:0db8:0001:0002::1'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::2'));
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');

    const limiter = createRateLimiter({ create: { limit: 1, windowMs: 60_000 } });
    const { call, close } = await serve({ rateLimit: limiter, clientIp: (req) => String(req.headers['x-test-client']) });
    try {
      const body = { title: 'IPv6', dates: ['2026-10-01'] };
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': '2001:db8:1:2::10' })).status).toBe(201);
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': '2001:db8:1:2::11' })).status).toBe(429);
      expect((await call('POST', '/api/polls', body, { 'X-Test-Client': '2001:db8:1:3::10' })).status).toBe(201);
    } finally {
      await close();
    }
  });

  it('tracks a bounded number of clients and evicts the oldest first', async () => {
    let now = 0;
    const limiter = createRateLimiter({ create: { limit: 1, windowMs: 60_000 } }, () => now, { maxClients: 3 });
    const { call, close } = await serve({ rateLimit: limiter, clientIp: (req) => String(req.headers['x-test-client']) });
    try {
      const body = { title: 'Crowd', dates: ['2026-10-01'] };
      const from = (client: string) => call('POST', '/api/polls', body, { 'X-Test-Client': client });
      for (const client of ['a', 'b', 'c']) {
        now += 1;
        expect((await from(client)).status).toBe(201);
      }
      expect((await from('a')).status).toBe(429);
      expect(limiter.trackedClients('create')).toBe(3);
      now += 1;
      expect((await from('d')).status).toBe(201);
      expect(limiter.trackedClients('create')).toBe(3);
      // "a" was the oldest window and got evicted; "c" is still counted.
      expect((await from('a')).status).toBe(201);
      expect((await from('c')).status).toBe(429);
      // Expired windows are dropped as time passes, without a full scan.
      now += 120_000;
      expect((await from('e')).status).toBe(201);
      expect(limiter.trackedClients('create')).toBe(1);
    } finally {
      await close();
    }
  });
});
