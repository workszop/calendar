import type { Poll } from "../src/types";
import type { PollStore } from "./poll-store";

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
}

export class PollStoreConflictError extends Error {
  readonly status = 409;
  readonly statusCode = 409;

  constructor() {
    super("Poll store was modified concurrently. Please retry the request.");
    this.name = "PollStoreConflictError";
  }
}

const MAX_CAS_ATTEMPTS = 5;

interface Snapshot {
  polls: Poll[];
  etag?: string;
}

function asPollArray(data: unknown): Poll[] {
  if (!Array.isArray(data)) throw new Error("Poll store must contain an array.");
  return data as Poll[];
}

export function createBlobPollStore(client: BlobClient): PollStore {
  async function readSnapshot(): Promise<Snapshot> {
    const result = await client.getWithMetadata("polls", { type: "json", consistency: "strong" });
    if (result === null) return { polls: [], etag: undefined };
    if (typeof result.etag !== "string" || !result.etag) {
      throw new Error("Poll store returned an existing blob without an ETag.");
    }
    return { polls: structuredClone(asPollArray(result.data)), etag: result.etag };
  }

  async function load(): Promise<Poll[]> {
    return (await readSnapshot()).polls;
  }

  async function mutate<T>(fn: (polls: Poll[]) => T): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot();
      const draft = structuredClone(snapshot.polls);
      const result = fn(draft);
      if (result === null || result === undefined) return result;

      // A missing key is created conditionally; an existing key is updated by
      // ETag. A false `modified` result is the only retryable outcome. Network
      // and other write exceptions deliberately propagate to the caller.
      const write = snapshot.etag
        ? await client.setJSON("polls", draft, { onlyIfMatch: snapshot.etag })
        : await client.setJSON("polls", draft, { onlyIfNew: true });
      if (typeof write.modified !== "boolean") {
        throw new Error("Poll store returned an invalid conditional-write result.");
      }
      if (write.modified) return result;
    }

    throw new PollStoreConflictError();
  }

  return { load, mutate };
}
