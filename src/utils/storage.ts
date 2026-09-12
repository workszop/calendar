// ─── Persisted identity ───
import type { GridInterval } from './grid';

// Remembers who is filling in polls on this device. localStorage can throw
// (private mode, disabled storage), so every access is guarded.

const STORAGE_KEYS = {
  userName: 'timesync_user_name',
  userEmail: 'timesync_user_email',
  gridInterval: 'timesync_grid_interval',
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
