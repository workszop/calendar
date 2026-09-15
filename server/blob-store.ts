import type { Poll } from "../src/types";
import {
  asStoredPoll,
  assertPollSize,
  isStorableId,
  PollStoreConflictError,
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
}

// ─── Keys ───
// One blob per poll under "poll/". The bare "polls" key is the old layout: a
// single array of every poll, imported and removed by the daily cleanup.

const KEY_PREFIX = "poll/";
const LEGACY_KEY = "polls";
const READ_OPTIONS = { type: "json", consistency: "strong" } as const;

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_MS = 15;
const DEFAULT_MAX_BACKOFF_MS = 400;

const pollKey = (id: string) => `${KEY_PREFIX}${id}`;

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

  async function get(id: string): Promise<Poll | null> {
    if (!isStorableId(id)) return null;
    return (await read(id))?.poll ?? null;
  }

  async function getMany(ids: string[]): Promise<Poll[]> {
    const polls = await Promise.all(ids.map(get));
    return polls.filter((poll): poll is Poll => poll !== null);
  }

  async function create(poll: Poll): Promise<boolean> {
    if (!isStorableId(poll.id)) throw new Error("Poll id is not storable.");
    assertPollSize(poll);
    if (writeOutcome(await client.setJSON(pollKey(poll.id), poll, { onlyIfNew: true }))) return true;
    // Either another poll owns the id, or this very write committed and only
    // its response was lost. The second case is a success.
    const existing = await read(poll.id);
    return existing !== null && JSON.stringify(existing.poll) === JSON.stringify(poll);
  }

  async function update<T>(id: string, fn: PollUpdater<T>): Promise<T | null> {
    if (!isStorableId(id)) return null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      const snapshot = await read(id);
      if (!snapshot) return null;
      const draft = snapshot.poll;
      const result = fn(draft);
      if (result === null || result === undefined) return null;
      assertPollSize(draft);

      // A false `modified` is the only retryable outcome. Network and other
      // write exceptions deliberately propagate to the caller.
      if (writeOutcome(await client.setJSON(pollKey(id), draft, { onlyIfMatch: snapshot.etag }))) return result;
    }
    throw new PollStoreConflictError();
  }

  async function remove(id: string): Promise<void> {
    if (!isStorableId(id)) return;
    await client.delete(pollKey(id));
  }

  async function listIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of client.list({ prefix: KEY_PREFIX, paginate: true })) {
      for (const blob of page.blobs) ids.push(blob.key.slice(KEY_PREFIX.length));
    }
    return ids;
  }

  async function importLegacyPolls(keep: (poll: Poll) => boolean) {
    const legacy = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
    if (legacy === null) return { imported: 0, dropped: 0 };
    if (!Array.isArray(legacy.data)) throw new Error("Legacy poll store must contain an array.");

    let imported = 0;
    let dropped = 0;
    for (const raw of legacy.data) {
      const poll = asStoredPoll(raw);
      if (!isStorableId(poll.id) || !keep(poll)) {
        dropped += 1;
        continue;
      }
      // onlyIfNew: a poll already moved (or re-created since) is never overwritten.
      await client.setJSON(pollKey(poll.id), poll, { onlyIfNew: true });
      imported += 1;
    }
    await client.delete(LEGACY_KEY);
    return { imported, dropped };
  }

  return { get, getMany, create, update, delete: remove, listIds, importLegacyPolls };
}
