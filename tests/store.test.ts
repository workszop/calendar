import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Poll } from "../src/types";
import { createBlobPollStore } from "../server/blob-store";
import { createFilePollStore } from "../server/poll-store";

const tempDirs: string[] = [];

const makePoll = (id: string): Poll => ({
  id,
  title: id,
  description: "",
  location: "Online Meeting",
  durationMinutes: 30,
  timezone: "UTC",
  dates: ["2027-01-01"],
  startHour: 9,
  endHour: 17,
  slotInterval: 30,
  creatorName: "Organizer",
  createdAt: "2027-01-01T00:00:00.000Z",
  finalizedSlot: null,
  participants: [],
});

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("file poll store", () => {
  it("loads an empty array, persists mutations, and skips null outcomes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-synch-store-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "polls.json");
    const store = createFilePollStore(filePath);

    await expect(store.load()).resolves.toEqual([]);
    const count = await store.mutate((polls) => {
      polls.push(makePoll("first"));
      return polls.length;
    });
    expect(count).toBe(1);
    const before = fs.readFileSync(filePath, "utf8");
    await expect(store.mutate(() => null)).resolves.toBeNull();
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    expect((await store.load()).map((poll) => poll.id)).toEqual(["first"]);
  });

  it("does not expose a draft that can mutate the cached state", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-synch-store-"));
    tempDirs.push(tempDir);
    const store = createFilePollStore(path.join(tempDir, "polls.json"));

    await store.mutate((polls) => {
      polls.push(makePoll("first"));
      return true;
    });
    const loaded = await store.load();
    loaded[0].title = "changed outside store";
    expect((await store.load())[0].title).toBe("first");
  });

  it("fails closed on malformed JSON and never replaces it with an empty array", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-synch-store-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "polls.json");
    const malformed = "{ definitely not an array";
    fs.writeFileSync(filePath, malformed, "utf8");
    const store = createFilePollStore(filePath);

    await expect(store.load()).rejects.toThrow();
    await expect(
      store.mutate((polls) => {
        polls.push(makePoll("never-written"));
        return true;
      })
    ).rejects.toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe(malformed);
  });
});

type BlobWriteOptions = { onlyIfMatch?: string; onlyIfNew?: boolean };

class MemoryBlobClient {
  data: unknown = undefined;
  exists = false;
  version = 0;
  readCalls: Array<{ key: string; options: Record<string, unknown> | undefined }> = [];
  writeCalls: Array<{ key: string; data: unknown; options: BlobWriteOptions | undefined }> = [];
  conflictsRemaining = 0;
  writeError: Error | undefined;
  holdInitialReads = false;
  private readonly pendingInitialReads: Array<(value: { data: unknown; etag: string }) => void> = [];

  private etag() {
    return `etag-${this.version}`;
  }

  async getWithMetadata(key: string, options?: Record<string, unknown>) {
    this.readCalls.push({ key, options });
    if (!this.exists) {
      if (this.holdInitialReads && this.pendingInitialReads.length < 2) {
        return new Promise<null>((resolve) => {
          this.pendingInitialReads.push(() => resolve(null));
          if (this.pendingInitialReads.length === 2) {
            for (const release of this.pendingInitialReads.splice(0)) release({ data: undefined, etag: "" });
          }
        });
      }
      return null;
    }
    return { data: structuredClone(this.data), etag: this.etag(), metadata: {} };
  }

  async setJSON(key: string, data: unknown, options?: BlobWriteOptions) {
    this.writeCalls.push({ key, data: structuredClone(data), options });
    if (this.writeError) throw this.writeError;
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      return { modified: false };
    }
    if (options?.onlyIfNew && this.exists) return { modified: false };
    if (options?.onlyIfMatch && (!this.exists || options.onlyIfMatch !== this.etag())) {
      return { modified: false };
    }
    this.exists = true;
    this.data = structuredClone(data);
    this.version += 1;
    return { modified: true, etag: this.etag() };
  }
}

describe("blob poll store", () => {
  it("reads missing data as empty and uses strong consistency plus conditional writes", async () => {
    const client = new MemoryBlobClient();
    const store = createBlobPollStore(client);

    await expect(store.load()).resolves.toEqual([]);
    await store.mutate((polls) => {
      polls.push(makePoll("first"));
      return true;
    });
    expect(client.readCalls[0]).toMatchObject({ key: "polls", options: { type: "json", consistency: "strong" } });
    expect(client.writeCalls[0].options).toEqual({ onlyIfNew: true });
    expect(client.writeCalls[1]?.options).toBeUndefined();
  });

  it("retries known CAS conflicts and keeps both independent writers", async () => {
    const client = new MemoryBlobClient();
    client.holdInitialReads = true;
    const first = createBlobPollStore(client);
    const second = createBlobPollStore(client);

    await Promise.all([
      first.mutate((polls) => {
        polls.push(makePoll("first"));
        return true;
      }),
      second.mutate((polls) => {
        polls.push(makePoll("second"));
        return true;
      }),
    ]);

    expect((await first.load()).map((poll) => poll.id).sort()).toEqual(["first", "second"]);
    expect(client.writeCalls.filter(({ options }) => options?.onlyIfNew).length).toBe(2);
    expect(client.writeCalls.some(({ options }) => Boolean(options?.onlyIfMatch))).toBe(true);
  });

  it("retries a transient conditional-write conflict but not a network error", async () => {
    const client = new MemoryBlobClient();
    client.conflictsRemaining = 1;
    const store = createBlobPollStore(client);
    await expect(
      store.mutate((polls) => {
        polls.push(makePoll("eventually-written"));
        return true;
      })
    ).resolves.toBe(true);
    expect(client.writeCalls).toHaveLength(2);

    const networkError = new Error("network is down");
    client.writeError = networkError;
    await expect(
      store.mutate((polls) => {
        polls.push(makePoll("not-written"));
        return true;
      })
    ).rejects.toBe(networkError);
    expect(client.writeCalls).toHaveLength(3);
    expect((await store.load()).map((poll) => poll.id)).toEqual(["eventually-written"]);
  });

  it("fails safely with 409 after bounded conflict retries", async () => {
    const client = new MemoryBlobClient();
    client.conflictsRemaining = 100;
    const store = createBlobPollStore(client);

    await expect(
      store.mutate((polls) => {
        polls.push(makePoll("never-written"));
        return true;
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(client.writeCalls.length).toBeGreaterThan(1);
    expect(client.writeCalls.length).toBeLessThan(10);
    expect(client.exists).toBe(false);
  });

  it("fails closed on corrupt or non-array blobs", async () => {
    const client = new MemoryBlobClient();
    client.exists = true;
    client.data = { not: "an array" };
    const store = createBlobPollStore(client);

    await expect(store.load()).rejects.toThrow();
    await expect(store.mutate(() => true)).rejects.toThrow();
    expect(client.writeCalls).toHaveLength(0);
  });
});
