import type { Poll } from "../src/types";
import { encodePoll } from "./poll-codec";
import {
  asStoredPoll,
  assertPollSize,
  isStorableId,
  PollStoreConflictError,
  samePoll,
  type LegacyImportResult,
  type PollStore,
  type PollUpdater,
} from "./poll-store";

export { PollStoreConflictError } from "./poll-store";

export interface BlobReadResult {
  data: unknown;
  etag?: string;
}

export interface BlobWriteResult {
  modified: boolean;
  etag?: string;
}

/** Structural subset of the Netlify Blobs Store used by this adapter. */
export interface BlobClient {
  getWithMetadata(
    key: string,
    options: { type: "json"; consistency: "strong" }
  ): Promise<BlobReadResult | null>;
  setJSON(
    key: string,
    data: unknown,
    options: { onlyIfNew: true } | { onlyIfMatch: string }
  ): Promise<BlobWriteResult>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; paginate: true }): AsyncIterable<{ blobs: Array<{ key: string }> }>;
}

export interface BlobStoreOptions {
  /** Read-modify-write attempts per update before the retryable 409. */
  maxAttempts?: number;
  /** Base delay for the jittered exponential backoff between attempts. */
  backoffMs?: number;
  /** Longest single backoff delay. */
  maxBackoffMs?: number;
  /** How long reads reuse one read of the legacy array, in ms. Writes always read it fresh. */
  legacyCacheMs?: number;
}

// ─── Keys ───
// One blob per poll under "poll/". The bare "polls" key is the old layout: a
// single array of every poll. Until the daily cleanup has imported and removed
// it, reads fall back to it and the first write to such a poll moves it into its
// own blob. Nothing ever adds entries to that array.

const KEY_PREFIX = "poll/";
const LEGACY_KEY = "polls";
const READ_OPTIONS = { type: "json", consistency: "strong" } as const;

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_MS = 15;
const DEFAULT_MAX_BACKOFF_MS = 400;
const DEFAULT_LEGACY_CACHE_MS = 2000;

const pollKey = (id: string) => `${KEY_PREFIX}${id}`;

/** Id of a raw legacy array entry, if it has one. */
const entryId = (entry: unknown) =>
  entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { id?: unknown }).id : undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeOutcome(write: BlobWriteResult): boolean {
  if (typeof write.modified !== "boolean") {
    throw new Error("Poll store returned an invalid conditional-write result.");
  }
  return write.modified;
}

export function createBlobPollStore(client: BlobClient, options: BlobStoreOptions = {}): PollStore {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const legacyCacheMs = options.legacyCacheMs ?? DEFAULT_LEGACY_CACHE_MS;

  /** Full jitter: a random delay up to an exponentially growing cap. */
  const backoff = (attempt: number) =>
    sleep(Math.random() * Math.min(maxBackoffMs, backoffMs * 2 ** attempt));

  async function read(id: string): Promise<{ poll: Poll; etag: string } | null> {
    const result = await client.getWithMetadata(pollKey(id), READ_OPTIONS);
    if (result === null) return null;
    if (typeof result.etag !== "string" || !result.etag) {
      throw new Error("Poll store returned an existing blob without an ETag.");
    }
    return { poll: structuredClone(asStoredPoll(result.data)), etag: result.etag };
  }

  // ─── Legacy array ───

  type LegacySnapshot = { entries: unknown[]; etag: string };

  /** Fresh read of the legacy array. A value that is not an array holds no usable polls. */
  async function readLegacy(): Promise<LegacySnapshot | null> {
    const result = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
    if (result === null) return null;
    if (!Array.isArray(result.data)) {
      console.error("Legacy poll array is not an array; ignoring it until cleanup reports it.");
      return null;
    }
    if (typeof result.etag !== "string" || !result.etag) {
      throw new Error("Poll store returned the legacy array without an ETag.");
    }
    return { entries: result.data, etag: result.etag };
  }

  let legacyCache: { at: number; value: Promise<LegacySnapshot | null> } | undefined;
  /** Set once the array was seen missing: it never comes back, so reads stop asking. */
  let legacyGone = false;

  /** Legacy read shared by reads within `legacyCacheMs`, so a list request reads the array once. */
  function cachedLegacy(): Promise<LegacySnapshot | null> {
    const now = Date.now();
    if (!legacyCache || now - legacyCache.at > legacyCacheMs) {
      const value = readLegacy().then((snapshot) => {
        if (snapshot === null) legacyGone = true;
        return snapshot;
      });
      const entry = { at: now, value };
      // A failed read is not reused.
      value.catch(() => {
        if (legacyCache === entry) legacyCache = undefined;
      });
      legacyCache = entry;
    }
    return legacyCache.value;
  }

  const forgetLegacy = () => {
    legacyCache = undefined;
  };

  /** Removes one poll from the legacy array with a conditional write. Resolves false if every attempt lost a race. */
  async function removeFromLegacy(id: string, attempts: number): Promise<boolean> {
    forgetLegacy();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      const legacy = await readLegacy();
      if (!legacy || !legacy.entries.some((entry) => entryId(entry) === id)) return true;
      const rest = legacy.entries.filter((entry) => entryId(entry) !== id);
      if (writeOutcome(await client.setJSON(LEGACY_KEY, rest, { onlyIfMatch: legacy.etag }))) return true;
    }
    return false;
  }

  // ─── Store ───

  async function get(id: string): Promise<Poll | null> {
    if (!isStorableId(id)) return null;
    const knownGone = legacyGone;
    const own = await read(id);
    if (own) return own.poll;
    if (knownGone) return null;

    const legacy = await cachedLegacy();
    const raw = legacy?.entries.find((entry) => entryId(entry) === id);
    if (raw !== undefined) return structuredClone(asStoredPoll(raw));
    // It may have moved out of the array between the two reads.
    return (await read(id))?.poll ?? null;
  }

  async function getMany(ids: string[]): Promise<Poll[]> {
    const polls = await Promise.all(ids.map(get));
    return polls.filter((poll): poll is Poll => poll !== null);
  }

  async function create(poll: Poll): Promise<boolean> {
    if (!isStorableId(poll.id)) throw new Error("Poll id is not storable.");
    assertPollSize(poll);
    if (writeOutcome(await client.setJSON(pollKey(poll.id), encodePoll(poll), { onlyIfNew: true }))) return true;
    // Either another poll owns the id, or this very write committed and only
    // its response was lost. The second case is a success.
    const existing = await read(poll.id);
    return existing !== null && samePoll(existing.poll, poll);
  }

  async function update<T>(id: string, fn: PollUpdater<T>): Promise<T | null> {
    if (!isStorableId(id)) return null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      const snapshot = await read(id);

      let draft: Poll;
      let condition: { onlyIfMatch: string } | { onlyIfNew: true };
      if (snapshot) {
        draft = snapshot.poll;
        condition = { onlyIfMatch: snapshot.etag };
      } else {
        // First write to a poll still in the legacy array: create its blob,
        // conditional on nobody having created it meanwhile.
        const legacy = await readLegacy();
        const raw = legacy?.entries.find((entry) => entryId(entry) === id);
        if (raw === undefined) {
          // Missing, unless another writer moved it between the two reads.
          if (await read(id)) continue;
          return null;
        }
        draft = structuredClone(asStoredPoll(raw));
        condition = { onlyIfNew: true };
      }

      const result = fn(draft);
      if (result === null || result === undefined) return null;
      assertPollSize(draft);

      // A false `modified` is the only retryable outcome. Network and other
      // write exceptions deliberately propagate to the caller. If a move
      // committed but reported a conflict, the next attempt finds the blob
      // and replays the closure on it, like any other CAS replay.
      if (!writeOutcome(await client.setJSON(pollKey(id), encodePoll(draft), condition))) continue;
      if ("onlyIfNew" in condition) {
        // The blob now wins over the array copy. Losing this race is harmless:
        // the daily cleanup deletes the whole array.
        await removeFromLegacy(id, 1).catch(() => false);
      }
      return result;
    }
    throw new PollStoreConflictError();
  }

  async function remove(id: string): Promise<void> {
    if (!isStorableId(id)) return;
    // Array first: a deleted blob with a leftover array copy would bring the poll back.
    if (!(await removeFromLegacy(id, maxAttempts))) throw new PollStoreConflictError();
    await client.delete(pollKey(id));
  }

  async function listIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of client.list({ prefix: KEY_PREFIX, paginate: true })) {
      for (const blob of page.blobs) ids.push(blob.key.slice(KEY_PREFIX.length));
    }
    return ids;
  }

  async function importLegacyPolls(keep: (poll: Poll) => boolean): Promise<LegacyImportResult> {
    const legacy = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
    if (legacy === null) return { imported: 0, dropped: 0, skipped: 0 };
    if (!Array.isArray(legacy.data)) throw new Error("Legacy poll store must contain an array.");

    let imported = 0;
    let dropped = 0;
    let skipped = 0;
    const written: string[] = [];
    for (const raw of legacy.data) {
      let poll: Poll;
      try {
        poll = asStoredPoll(raw);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isStorableId(poll.id) || !keep(poll)) {
        dropped += 1;
        continue;
      }
      // onlyIfNew: a poll already moved (or re-created since) is never overwritten.
      if (writeOutcome(await client.setJSON(pollKey(poll.id), encodePoll(poll), { onlyIfNew: true }))) {
        written.push(poll.id);
      }
      imported += 1;
    }

    // A poll deleted while this import ran is gone from the array by now; do
    // not bring it back. Without a readable array there is nothing to compare.
    if (written.length) {
      const fresh = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
      if (fresh && Array.isArray(fresh.data)) {
        const remaining = new Set(fresh.data.map(entryId));
        for (const id of written.filter((id) => !remaining.has(id))) {
          await client.delete(pollKey(id));
          imported -= 1;
        }
      }
    }
    await client.delete(LEGACY_KEY);
    forgetLegacy();
    return { imported, dropped, skipped };
  }

  return { get, getMany, create, update, delete: remove, listIds, importLegacyPolls };
}
