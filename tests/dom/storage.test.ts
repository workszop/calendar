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
