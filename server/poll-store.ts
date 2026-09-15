import fs from "fs";
import path from "path";
import type { Poll } from "../src/types";
import { MAX_POLL_BYTES, POLL_ID_RE } from "../src/utils/limits";

// ─── Store contract ───
// Every poll is its own record. Callers never see or rewrite other polls, so a
// write to one poll cannot conflict with a write to another.

/**
 * Read-modify-write step for one poll. It receives a private draft and may
 * mutate it. Returning null or undefined means "do not write". The closure may
 * run more than once (compare-and-swap retries), so it must not keep side
 * effects from an earlier run.
 */
export type PollUpdater<T> = (draft: Poll) => T | null | undefined;

export interface PollStore {
  /** The poll, or null when it does not exist. */
  get(id: string): Promise<Poll | null>;
  /** Existing polls among `ids`, in the order asked for. Missing ids are skipped. */
  getMany(ids: string[]): Promise<Poll[]>;
  /**
   * Stores a new poll. Resolves true when it is stored (including a replay of the
   * very same poll), false when a different poll already owns the id.
   */
  create(poll: Poll): Promise<boolean>;
  /** Applies `fn` to the stored poll. Resolves null when the poll is missing or `fn` skipped the write. */
  update<T>(id: string, fn: PollUpdater<T>): Promise<T | null>;
  /** Removes the poll if it exists. */
  delete(id: string): Promise<void>;
  /** Ids of every stored poll, for the retention sweep. */
  listIds(): Promise<string[]>;
  /**
   * Moves polls from a pre-per-poll storage layout into per-poll records, keeping
   * only those `keep` accepts, then deletes the old layout. Only stores that ever
   * had another layout implement it.
   */
  importLegacyPolls?(keep: (poll: Poll) => boolean): Promise<{ imported: number; dropped: number }>;
}

// ─── Store errors ───

/** Contention outlasted the retries. The API answers 409 with `retryable: true`. */
export class PollStoreConflictError extends Error {
  readonly status = 409;
  readonly statusCode = 409;
  readonly retryable = true;

  constructor() {
    super("The poll was changed by someone else at the same moment. Please try again.");
    this.name = "PollStoreConflictError";
  }
}

/** A write would make one stored poll larger than MAX_POLL_BYTES. */
export class PollTooLargeError extends Error {
  readonly status = 413;
  readonly statusCode = 413;

  constructor() {
    super(
      `This poll has reached its storage limit of ${Math.round(MAX_POLL_BYTES / 1_000_000)} MB. ` +
        "Remove old responses or dates before saving more."
    );
    this.name = "PollTooLargeError";
  }
}

// ─── Shared checks ───

/** Compact JSON size of a poll in bytes. */
export function pollBytes(poll: Poll): number {
  return Buffer.byteLength(JSON.stringify(poll), "utf8");
}

/** Throws PollTooLargeError when the poll may not be stored. */
export function assertPollSize(poll: Poll): void {
  if (pollBytes(poll) > MAX_POLL_BYTES) throw new PollTooLargeError();
}

/** Ids outside the public id format can never name a stored poll. */
export function isStorableId(id: string): boolean {
  return POLL_ID_RE.test(id);
}

/** A stored record must at least look like a poll; anything else is corruption. */
export function asStoredPoll(data: unknown): Poll {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof (data as Poll).id !== "string") {
    throw new Error("Poll store returned a record that is not a poll.");
  }
  return data as Poll;
}

// ─── File store (local server) ───

/**
 * One JSON array file behind the per-poll interface. Writes go through one
 * in-process queue, so concurrent requests never lose updates. The file format
 * is unchanged from earlier versions, so existing data files keep working.
 */
export function createFilePollStore(dataFile: string): PollStore {
  let cache: Poll[] | null = null;
  let cacheStamp = "";
  let queue: Promise<unknown> = Promise.resolve();

  function ensureDataFile() {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "[]", "utf-8");
  }

  /** Cheap fingerprint of the file on disk, so out-of-band edits invalidate the cache. */
  function diskStamp(): string {
    try {
      const stat = fs.statSync(dataFile);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  }

  function readPolls(): Poll[] {
    ensureDataFile();
    const stamp = diskStamp();
    if (cache && stamp === cacheStamp) return cache;

    // Do not turn malformed storage into an empty one. If JSON.parse or the
    // shape check fails, no write can reach savePolls below.
    const parsed: unknown = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("Poll store must contain an array.");
    cache = parsed.map(asStoredPoll);
    cacheStamp = stamp;
    return cache;
  }

  function savePolls(polls: Poll[]) {
    ensureDataFile();
    const tempFile = `${dataFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(polls, null, 2), "utf-8");
    fs.renameSync(tempFile, dataFile);
    // Publish the new state only once it is durable on disk.
    cache = polls;
    cacheStamp = diskStamp();
  }

  /** Runs one write after every earlier one has finished. */
  function enqueue<T>(fn: () => T): Promise<T> {
    const run = queue.then(fn);
    // Keep the chain alive even when one write rejects.
    queue = run.catch(() => undefined);
    return run;
  }

  async function get(id: string): Promise<Poll | null> {
    if (!isStorableId(id)) return null;
    const found = readPolls().find((poll) => poll.id === id);
    return found ? structuredClone(found) : null;
  }

  async function getMany(ids: string[]): Promise<Poll[]> {
    const polls = readPolls();
    return ids.flatMap((id) => {
      const found = isStorableId(id) ? polls.find((poll) => poll.id === id) : undefined;
      return found ? [structuredClone(found)] : [];
    });
  }

  function create(poll: Poll): Promise<boolean> {
    return enqueue(() => {
      if (!isStorableId(poll.id)) throw new Error("Poll id is not storable.");
      const polls = readPolls();
      const existing = polls.find((candidate) => candidate.id === poll.id);
      if (existing) return JSON.stringify(existing) === JSON.stringify(poll);
      assertPollSize(poll);
      savePolls([structuredClone(poll), ...polls]);
      return true;
    });
  }

  function update<T>(id: string, fn: PollUpdater<T>): Promise<T | null> {
    return enqueue(() => {
      if (!isStorableId(id)) return null;
      const polls = readPolls();
      const index = polls.findIndex((poll) => poll.id === id);
      if (index === -1) return null;
      const draft = structuredClone(polls[index]);
      const result = fn(draft);
      if (result === null || result === undefined) return null;
      assertPollSize(draft);
      const next = [...polls];
      // The caller keeps the draft (and results pointing into it); the cache gets its own copy.
      next[index] = structuredClone(draft);
      savePolls(next);
      return result;
    });
  }

  function remove(id: string): Promise<void> {
    return enqueue(() => {
      const polls = readPolls();
      // Nothing to remove: no write.
      if (!polls.some((poll) => poll.id === id)) return;
      savePolls(polls.filter((poll) => poll.id !== id));
    });
  }

  async function listIds(): Promise<string[]> {
    return readPolls().map((poll) => poll.id);
  }

  return { get, getMany, create, update, delete: remove, listIds };
}
