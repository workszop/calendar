import type { Poll } from "../src/types";
import { decodePoll, encodePoll } from "../src/utils/pollCodec";
import {
  assertEncodedPollSize,
  isStorableId,
  PollStoreConflictError,
  PollUnreadableError,
  readStoredPoll,
  samePoll,
  type LegacyImportOptions,
  type LegacyImportResult,
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
  /** Polls read at once by getMany and moved at once by the legacy import. */
  concurrency?: number;
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
const DEFAULT_CONCURRENCY = 8;

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

  // ─── Legacy array ───

  type LegacySnapshot = { entries: unknown[]; etag: string };

  /** Set once the array was seen missing: it never comes back, so reads stop asking. */
  let legacyGone = false;

  /** Fresh read of the legacy array. A value that is not an array holds no usable polls. */
  async function readLegacy(): Promise<LegacySnapshot | null> {
    if (legacyGone) return null;
    const result = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
    if (result === null) {
      legacyGone = true;
      return null;
    }
    if (!Array.isArray(result.data)) {
      console.error("Legacy poll array is not an array; ignoring it until cleanup reports it.");
      return null;
    }
    if (typeof result.etag !== "string" || !result.etag) {
      throw new Error("Poll store returned the legacy array without an ETag.");
    }
    return { entries: result.data, etag: result.etag };
  }

  /** Removes one poll from the legacy array with a conditional write. Resolves false if every attempt lost a race. */
  async function removeFromLegacy(id: string, attempts: number): Promise<boolean> {
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

  /**
   * One poll: its own blob, else its legacy array copy. `legacy` supplies the
   * array read, so a list request can share one read across its ids while a
   * single read always sees the current array.
   */
  async function getWith(id: string, legacy: () => Promise<LegacySnapshot | null>): Promise<Poll | null> {
    if (!isStorableId(id)) return null;
    const own = await read(id);
    if (own) return own.poll;

    const snapshot = await legacy();
    const raw = snapshot?.entries.find((entry) => entryId(entry) === id);
    // The snapshot may be shared with other ids: give this caller its own copy.
    if (raw !== undefined) return structuredClone(readStoredPoll(id, raw));
    // It may have moved out of the array between the two reads.
    return (await read(id))?.poll ?? null;
  }

  const get = (id: string) => getWith(id, readLegacy);

  async function getMany(ids: string[]): Promise<Poll[]> {
    let shared: Promise<LegacySnapshot | null> | undefined;
    const legacyOnce = () => (shared ??= readLegacy());
    // One corrupt record must not hide the other polls in the list. A failing
    // transport is a different matter and still fails the whole request.
    const polls = await mapLimit(ids, concurrency, async (id) => {
      try {
        return await getWith(id, legacyOnce);
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
        draft = readStoredPoll(id, raw);
        condition = { onlyIfNew: true };
      }

      const result = fn(draft);
      if (result === null || result === undefined) return null;
      // Encoded once per attempt: the size check and the write share it.
      const encoded = encodePoll(draft);
      assertEncodedPollSize(encoded);

      // A false `modified` is the only retryable outcome. Network and other
      // write exceptions deliberately propagate to the caller. If a move
      // committed but reported a conflict, the next attempt finds the blob
      // and replays the closure on it, like any other CAS replay.
      if (!writeOutcome(await client.setJSON(pollKey(id), encoded, condition))) continue;
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

  async function importLegacyPolls(
    keep: (poll: Poll) => boolean,
    options: LegacyImportOptions = {}
  ): Promise<LegacyImportResult> {
    const shouldStop = options.shouldStop ?? (() => false);
    const legacy = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
    if (legacy === null) return { imported: 0, dropped: 0, skipped: 0, remaining: 0 };
    if (!Array.isArray(legacy.data)) throw new Error("Legacy poll store must contain an array.");

    const report: LegacyImportResult = { imported: 0, dropped: 0, skipped: 0, remaining: 0 };
    const written: string[] = [];
    const queue = [...legacy.data];
    const worker = async () => {
      while (queue.length && !shouldStop()) {
        const raw = queue.shift();
        let poll: Poll;
        try {
          poll = decodePoll(raw);
        } catch {
          report.skipped += 1;
          continue;
        }
        if (!isStorableId(poll.id) || !keep(poll)) {
          report.dropped += 1;
          continue;
        }
        // onlyIfNew: a poll already moved (or re-created since) is never overwritten.
        if (writeOutcome(await client.setJSON(pollKey(poll.id), encodePoll(poll), { onlyIfNew: true }))) {
          written.push(poll.id);
          report.imported += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    report.remaining = queue.length;

    // A poll deleted while this import ran is gone from the array by now; do
    // not bring it back. Without a readable array there is nothing to compare.
    if (written.length) {
      const fresh = await client.getWithMetadata(LEGACY_KEY, READ_OPTIONS);
      if (fresh && Array.isArray(fresh.data)) {
        const remaining = new Set(fresh.data.map(entryId));
        for (const id of written.filter((id) => !remaining.has(id))) {
          await client.delete(pollKey(id));
          report.imported -= 1;
        }
      }
    }
    // Stopped early: the array stays for the next run, which skips moved polls via onlyIfNew.
    if (report.remaining === 0) await client.delete(LEGACY_KEY);
    return report;
  }

  return { get, getMany, create, update, delete: remove, listIds, importLegacyPolls };
}
