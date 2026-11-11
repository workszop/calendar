import type { Poll } from "../src/types";
import { encodePoll } from "../src/utils/pollCodec";
import {
  assertEncodedPollSize,
  isStorableId,
  PollStoreConflictError,
  PollUnreadableError,
  readStoredPoll,
  samePoll,
  type PollStore,
  type PollUpdater,
} from "./poll-store";

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
  /** Polls read at once by getMany. */
  concurrency?: number;
}

// ─── Keys ───
// One blob per poll under "poll/".

const KEY_PREFIX = "poll/";
const READ_OPTIONS = { type: "json", consistency: "strong" } as const;

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_MS = 15;
const DEFAULT_MAX_BACKOFF_MS = 400;
const DEFAULT_CONCURRENCY = 8;

const pollKey = (id: string) => `${KEY_PREFIX}${id}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeOutcome(write: BlobWriteResult): boolean {
  if (typeof write.modified !== "boolean") {
    throw new Error("Poll store returned an invalid conditional-write result.");
  }
  return write.modified;
}

/** Runs `task` over `items` with at most `limit` in flight, keeping result order. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createBlobPollStore(client: BlobClient, options: BlobStoreOptions = {}): PollStore {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  /** Full jitter: a random delay up to an exponentially growing cap. */
  const backoff = (attempt: number) =>
    sleep(Math.random() * Math.min(maxBackoffMs, backoffMs * 2 ** attempt));

  // Every read parses a fresh JSON document, so the decoded poll is handed out
  // as is: no copy is needed to keep callers from touching stored state.
  async function read(id: string): Promise<{ poll: Poll; etag: string } | null> {
    const result = await client.getWithMetadata(pollKey(id), READ_OPTIONS);
    if (result === null) return null;
    if (typeof result.etag !== "string" || !result.etag) {
      throw new Error("Poll store returned an existing blob without an ETag.");
    }
    return { poll: readStoredPoll(id, result.data), etag: result.etag };
  }

  // ─── Store ───

  async function get(id: string): Promise<Poll | null> {
    if (!isStorableId(id)) return null;
    return (await read(id))?.poll ?? null;
  }

  async function getMany(ids: string[]): Promise<Poll[]> {
    // One corrupt record must not hide the other polls in the list. A failing
    // transport is a different matter and still fails the whole request.
    const polls = await mapLimit(ids, concurrency, async (id) => {
      try {
        return await get(id);
      } catch (err) {
        if (!(err instanceof PollUnreadableError)) throw err;
        console.error(`Poll store: ${err.message} Leaving it out of the list:`, err.cause);
        return null;
      }
    });
    return polls.filter((poll): poll is Poll => poll !== null);
  }

  async function create(poll: Poll): Promise<boolean> {
    if (!isStorableId(poll.id)) throw new Error("Poll id is not storable.");
    const encoded = encodePoll(poll);
    assertEncodedPollSize(encoded);
    if (writeOutcome(await client.setJSON(pollKey(poll.id), encoded, { onlyIfNew: true }))) return true;
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
      if (!snapshot) return null;
      const draft = snapshot.poll;

      const result = fn(draft);
      if (result === null || result === undefined) return null;
      // Encoded once per attempt: the size check and the write share it.
      const encoded = encodePoll(draft);
      assertEncodedPollSize(encoded);

      // A false `modified` is the only retryable outcome. Network and other
      // write exceptions deliberately propagate to the caller.
      if (!writeOutcome(await client.setJSON(pollKey(id), encoded, { onlyIfMatch: snapshot.etag }))) continue;
      return result;
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

  return { get, getMany, create, update, delete: remove, listIds };
}
