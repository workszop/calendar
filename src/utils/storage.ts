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
  pendingEditCodes: 'timesync_pending_edit_codes',
  recentPolls: 'timesync_recent_polls',
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

/** How many polls the recency list remembers; older entries fall off. */
export const MAX_RECENT_POLLS = 100;

// Maps whose last write to localStorage failed. While a key is here, its memory
// copy is the truth, even if getItem still returns an older stored value.
const memoryMaps = new Map<string, Record<string, unknown>>();

function readMap<T>(key: string): Record<string, T> {
  const memory = memoryMaps.get(key);
  if (memory) return memory as Record<string, T>;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return {};
  }
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
    memoryMaps.delete(key);
  } catch {
    // Storage unavailable: the memory copy lasts until the page is closed.
    memoryMaps.set(key, map);
  }
}

function withoutKey<T>(map: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _removed, ...rest } = map;
  return rest;
}

export function getOrganizerCode(pollId: string): string | undefined {
  const code = readMap<unknown>(STORAGE_KEYS.organizerCodes)[pollId];
  return typeof code === 'string' && code ? code : undefined;
}

export function setOrganizerCode(pollId: string, code: string): void {
  writeMap(STORAGE_KEYS.organizerCodes, { ...withoutKey(readMap<string>(STORAGE_KEYS.organizerCodes), pollId), [pollId]: code });
}

export function removeOrganizerCode(pollId: string): void {
  writeMap(STORAGE_KEYS.organizerCodes, withoutKey(readMap<string>(STORAGE_KEYS.organizerCodes), pollId));
  pruneRecentPoll(pollId);
}

export function getStoredResponse(pollId: string): StoredResponse | undefined {
  const entry = readMap<Partial<StoredResponse>>(STORAGE_KEYS.responses)[pollId];
  return entry && typeof entry.participantId === 'string' && typeof entry.editCode === 'string'
    ? { participantId: entry.participantId, editCode: entry.editCode }
    : undefined;
}

export function setStoredResponse(pollId: string, response: StoredResponse): void {
  writeMap(STORAGE_KEYS.responses, { ...withoutKey(readMap<StoredResponse>(STORAGE_KEYS.responses), pollId), [pollId]: response });
}

export function removeStoredResponse(pollId: string): void {
  writeMap(STORAGE_KEYS.responses, withoutKey(readMap<StoredResponse>(STORAGE_KEYS.responses), pollId));
  pruneRecentPoll(pollId);
}

// ─── Pending edit codes ───
// A first save sends an edit code made in the browser. It is kept until the
// save succeeds, so a retry after a lost response updates the same answer.

export function getPendingEditCode(pollId: string): string | undefined {
  const code = readMap<unknown>(STORAGE_KEYS.pendingEditCodes)[pollId];
  return typeof code === 'string' && code ? code : undefined;
}

export function setPendingEditCode(pollId: string, code: string): void {
  writeMap(STORAGE_KEYS.pendingEditCodes, { ...readMap<string>(STORAGE_KEYS.pendingEditCodes), [pollId]: code });
}

export function clearPendingEditCode(pollId: string): void {
  const codes = readMap<string>(STORAGE_KEYS.pendingEditCodes);
  if (pollId in codes) writeMap(STORAGE_KEYS.pendingEditCodes, withoutKey(codes, pollId));
}

// ─── Recent polls ───
// One recency list (poll id -> last touched time) orders the home page, so a
// created poll is never pushed out just because answered polls list later.

/** Marks a poll as just created, answered or opened with a verified code. */
export function touchPoll(pollId: string, now = Date.now()): void {
  const recent = { ...readMap<number>(STORAGE_KEYS.recentPolls), [pollId]: now };
  const kept = Object.entries(recent)
    .filter(([, time]) => typeof time === 'number' && Number.isFinite(time))
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_RECENT_POLLS);
  writeMap(STORAGE_KEYS.recentPolls, Object.fromEntries(kept));
}

/**
 * Drops a poll from the recency list once neither of its codes remains: a
 * poll this device can no longer manage or update is not "created or answered
 * here" any more, so the home page stops listing it.
 */
function pruneRecentPoll(pollId: string): void {
  if (getOrganizerCode(pollId) || getStoredResponse(pollId)) return;
  const recent = readMap<number>(STORAGE_KEYS.recentPolls);
  if (pollId in recent) writeMap(STORAGE_KEYS.recentPolls, withoutKey(recent, pollId));
}

/** Drops every code for a poll, e.g. after it was deleted. */
export function forgetPoll(pollId: string): void {
  removeOrganizerCode(pollId);
  removeStoredResponse(pollId);
  clearPendingEditCode(pollId);
}

/** Polls this device created or answered, most recently touched first. */
export function getKnownPollIds(limit: number): string[] {
  const recent = readMap<unknown>(STORAGE_KEYS.recentPolls);
  // Polls saved before the recency list existed have no time: they keep their
  // old order (newest insert first) behind every touched poll.
  const legacy = [
    ...Object.keys(readMap(STORAGE_KEYS.organizerCodes)),
    ...Object.keys(readMap(STORAGE_KEYS.responses)),
  ].reverse();
  const ids = [...new Set([...Object.keys(recent), ...legacy])];
  const timeOf = (id: string) => {
    const time = recent[id];
    return typeof time === 'number' && Number.isFinite(time) ? time : 0;
  };
  // Array.prototype.sort is stable, so untimed ids stay in legacy order.
  return ids.sort((a, b) => timeOf(b) - timeOf(a)).slice(0, limit);
}
