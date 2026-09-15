import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoredUser, setStoredUser } from '../../src/utils/storage';

const NAME_KEY = 'timesync_user_name';
const EMAIL_KEY = 'timesync_user_email';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

// ─── setStoredUser ───
describe('setStoredUser', () => {
  it('writes the fields it is given', () => {
    setStoredUser({ name: 'Ann', email: 'ann@example.com' });
    expect(localStorage.getItem(NAME_KEY)).toBe('Ann');
    expect(localStorage.getItem(EMAIL_KEY)).toBe('ann@example.com');
  });

  it('removes the key when the value is an empty string', () => {
    localStorage.setItem(NAME_KEY, 'Ann');
    setStoredUser({ name: '' });
    expect(localStorage.getItem(NAME_KEY)).toBeNull();
  });

  it('leaves a key untouched when the field is undefined', () => {
    localStorage.setItem(NAME_KEY, 'Ann');
    localStorage.setItem(EMAIL_KEY, 'ann@example.com');
    setStoredUser({ email: 'new@example.com' });
    expect(localStorage.getItem(NAME_KEY)).toBe('Ann');
    expect(localStorage.getItem(EMAIL_KEY)).toBe('new@example.com');
  });

  it('stays quiet when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => setStoredUser({ name: 'Ann' })).not.toThrow();
  });
});

// ─── getStoredUser ───
describe('getStoredUser', () => {
  it('returns empty strings when nothing is stored', () => {
    expect(getStoredUser()).toEqual({ name: '', email: '' });
  });

  it('returns empty strings when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(getStoredUser()).toEqual({ name: '', email: '' });
  });
});

// ─── Poll codes with a failing setItem ───
// Each test loads a fresh module so the session memory copy starts empty.
async function freshStorage() {
  vi.resetModules();
  return import('../../src/utils/storage');
}

function failWrites() {
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota exceeded');
  });
}

describe('poll codes when setItem throws but getItem works', () => {
  it('keeps a newly written organizer code readable for the session', async () => {
    const storage = await freshStorage();
    failWrites();
    storage.setOrganizerCode('p1', 'code-1');
    expect(storage.getOrganizerCode('p1')).toBe('code-1');
  });

  it('prefers the memory copy over an older stored value', async () => {
    localStorage.setItem('timesync_organizer_codes', JSON.stringify({ p1: 'old-code' }));
    const storage = await freshStorage();
    failWrites();
    storage.setOrganizerCode('p1', 'new-code');
    storage.setStoredResponse('p1', { participantId: 'part_1', editCode: 'edit-1' });
    expect(storage.getOrganizerCode('p1')).toBe('new-code');
    expect(storage.getStoredResponse('p1')).toEqual({ participantId: 'part_1', editCode: 'edit-1' });
    expect(storage.getKnownPollIds(10)).toEqual(['p1']);
  });

  it('hands back to localStorage once a later write succeeds', async () => {
    const storage = await freshStorage();
    const setItem = failWrites();
    storage.setOrganizerCode('p1', 'code-1');
    setItem.mockRestore();
    storage.setOrganizerCode('p2', 'code-2');
    expect(JSON.parse(localStorage.getItem('timesync_organizer_codes') ?? '{}')).toEqual({ p1: 'code-1', p2: 'code-2' });
    expect(storage.getOrganizerCode('p1')).toBe('code-1');
  });

  it('keeps a pending edit code readable', async () => {
    const storage = await freshStorage();
    failWrites();
    storage.setPendingEditCode('p1', 'x'.repeat(43));
    expect(storage.getPendingEditCode('p1')).toBe('x'.repeat(43));
    storage.clearPendingEditCode('p1');
    expect(storage.getPendingEditCode('p1')).toBeUndefined();
  });
});

// ─── Recent polls ───
describe('getKnownPollIds', () => {
  it('orders polls by last touch, whatever their kind', async () => {
    const storage = await freshStorage();
    storage.setOrganizerCode('created-old', 'c1');
    storage.touchPoll('created-old', 100);
    storage.setStoredResponse('answered', { participantId: 'a', editCode: 'e' });
    storage.touchPoll('answered', 200);
    storage.setOrganizerCode('created-new', 'c2');
    storage.touchPoll('created-new', 300);
    expect(storage.getKnownPollIds(10)).toEqual(['created-new', 'answered', 'created-old']);
    expect(storage.getKnownPollIds(2)).toEqual(['created-new', 'answered']);
  });

  it('does not let many answered polls push out a recently created one', async () => {
    const storage = await freshStorage();
    storage.setOrganizerCode('mine', 'code');
    storage.touchPoll('mine', 5_000);
    for (let i = 0; i < 60; i += 1) {
      storage.setStoredResponse(`answered-${i}`, { participantId: 'p', editCode: 'e' });
      storage.touchPoll(`answered-${i}`, 1_000 + i);
    }
    const ids = storage.getKnownPollIds(50);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('mine');
  });

  it('lists polls stored before the recency list after touched ones', async () => {
    localStorage.setItem('timesync_organizer_codes', JSON.stringify({ legacy1: 'a', legacy2: 'b' }));
    const storage = await freshStorage();
    storage.touchPoll('fresh', 10);
    expect(storage.getKnownPollIds(10)).toEqual(['fresh', 'legacy2', 'legacy1']);
  });

  it('caps the remembered recency list', async () => {
    const storage = await freshStorage();
    for (let i = 0; i < storage.MAX_RECENT_POLLS + 5; i += 1) storage.touchPoll(`p${i}`, i);
    const recent = JSON.parse(localStorage.getItem('timesync_recent_polls') ?? '{}');
    expect(Object.keys(recent)).toHaveLength(storage.MAX_RECENT_POLLS);
    expect(recent.p0).toBeUndefined();
  });

  it('forgets every trace of a poll', async () => {
    const storage = await freshStorage();
    storage.setOrganizerCode('gone', 'c');
    storage.setStoredResponse('gone', { participantId: 'p', editCode: 'e' });
    storage.setPendingEditCode('gone', 'x'.repeat(43));
    storage.touchPoll('gone', 1);
    storage.forgetPoll('gone');
    expect(storage.getOrganizerCode('gone')).toBeUndefined();
    expect(storage.getStoredResponse('gone')).toBeUndefined();
    expect(storage.getPendingEditCode('gone')).toBeUndefined();
    expect(storage.getKnownPollIds(10)).toEqual([]);
  });
});
