import fs from "fs";
import path from "path";
import type { Poll } from "../src/types";

export interface PollStore {
  load(): Promise<Poll[]>;
  mutate<T>(fn: (polls: Poll[]) => T): Promise<T>;
}

/** JSON-backed PollStore retaining the original cache, queue, and atomic-write semantics. */
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
    // shape check fails, no mutation can reach savePolls below.
    const parsed: unknown = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("Poll store must contain an array.");
    cache = parsed as Poll[];
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

  async function load(): Promise<Poll[]> {
    return structuredClone(readPolls());
  }

  function mutate<T>(fn: (polls: Poll[]) => T): Promise<T> {
    const run = queue.then(() => {
      const draft = structuredClone(readPolls());
      const result = fn(draft);
      if (result !== null && result !== undefined) savePolls(draft);
      return result;
    });
    // Keep the chain alive even when one mutation rejects.
    queue = run.catch(() => undefined);
    return run;
  }

  return { load, mutate };
}
