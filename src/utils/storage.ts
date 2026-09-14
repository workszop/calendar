// ─── Persisted identity ───
import type { GridInterval } from './grid';

// Remembers who is filling in polls on this device. localStorage can throw
// (private mode, disabled storage), so every access is guarded.

const STORAGE_KEYS = {
  userName: 'timesync_user_name',
  userEmail: 'timesync_user_email',
  gridInterval: 'timesync_grid_interval',
  organizerCodes: 'timesync_organizer_codes',
  responses: 'timesync_responses',
} as const;

export function getStoredGridInterval(): GridInterval {
  try {
    return localStorage.getItem(STORAGE_KEYS.gridInterval) === '60' ? 60 : 30;
  } catch {
    return 30;
  }
}

export function setStoredGridInterval(interval: GridInterval): void {
  try {
    localStorage.setItem(STORAGE_KEYS.gridInterval, String(interval));
  } catch {
    // View switching still works when browser storage is disabled.
  }
}

export function getStoredUser(): { name: string; email: string } {
  try {
    return {
      name: localStorage.getItem(STORAGE_KEYS.userName) || '',
      email: localStorage.getItem(STORAGE_KEYS.userEmail) || '',
    };
  } catch {
    return { name: '', email: '' };
  }
}

/**
 * Writes the fields that are present. An empty string clears that key;
 * a field left undefined keeps whatever is already stored.
 */
export function setStoredUser(user: { name?: string; email?: string }): void {
  const write = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  };
  try {
    write(STORAGE_KEYS.userName, user.name);
    write(STORAGE_KEYS.userEmail, user.email);
  } catch {
    // Storage unavailable - identity simply is not remembered.
  }
}

// ─── Poll access codes ───
// Organizer codes and each response's edit code live on this device only. A
// memory copy keeps them usable for the session when storage is blocked.

export interface StoredResponse {
  participantId: string;
  editCode: string;
}

const memoryMaps = new Map<string, Record<string, unknown>>();

function readMap<T>(key: string): Record<string, T> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return (memoryMaps.get(key) as Record<string, T>) ?? {};
  }
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>): void {
  memoryMaps.set(key, map);
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Storage unavailable: the memory copy lasts until the page is closed.
  }
}

export function getOrganizerCode(pollId: string): string | undefined {
  const code = readMap<unknown>(STORAGE_KEYS.organizerCodes)[pollId];
  return typeof code === 'string' && code ? code : undefined;
}

export function setOrganizerCode(pollId: string, code: string): void {
  // Re-inserting moves the poll to the end, so the newest polls list first.
  const { [pollId]: _previous, ...rest } = readMap<string>(STORAGE_KEYS.organizerCodes);
  writeMap(STORAGE_KEYS.organizerCodes, { ...rest, [pollId]: code });
}

export function getStoredResponse(pollId: string): StoredResponse | undefined {
  const entry = readMap<Partial<StoredResponse>>(STORAGE_KEYS.responses)[pollId];
  return entry && typeof entry.participantId === 'string' && typeof entry.editCode === 'string'
    ? { participantId: entry.participantId, editCode: entry.editCode }
    : undefined;
}

export function setStoredResponse(pollId: string, response: StoredResponse): void {
  const { [pollId]: _previous, ...rest } = readMap<StoredResponse>(STORAGE_KEYS.responses);
  writeMap(STORAGE_KEYS.responses, { ...rest, [pollId]: response });
}

export function removeStoredResponse(pollId: string): void {
  const { [pollId]: _removed, ...rest } = readMap<StoredResponse>(STORAGE_KEYS.responses);
  writeMap(STORAGE_KEYS.responses, rest);
}

/** Drops every code for a poll, e.g. after it was deleted. */
export function forgetPoll(pollId: string): void {
  const { [pollId]: _code, ...codes } = readMap<string>(STORAGE_KEYS.organizerCodes);
  writeMap(STORAGE_KEYS.organizerCodes, codes);
  removeStoredResponse(pollId);
}

/** Polls this device created or answered; within each kind, the newest first. */
export function getKnownPollIds(limit: number): string[] {
  const ids = [
    ...Object.keys(readMap(STORAGE_KEYS.organizerCodes)),
    ...Object.keys(readMap(STORAGE_KEYS.responses)),
  ].reverse();
  return [...new Set(ids)].slice(0, limit);
}
