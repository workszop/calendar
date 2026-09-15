import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Poll } from "../src/types";
import { MAX_POLL_BYTES } from "../src/utils/limits";
import { createBlobPollStore } from "../server/blob-store";
import { createFilePollStore, PollStoreConflictError, PollTooLargeError, type PollStore } from "../server/poll-store";
import { MemoryBlobClient } from "./memory-blob-client";

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
  organizerCodeHash: "a".repeat(64),
});

const tempFile = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-synch-store-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "polls.json");
};

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

const addParticipant = (draft: Poll, name: string) => {
  draft.participants.push({ id: `part_${name}`, name, timezone: "UTC", updatedAt: "", availability: {} });
  return draft.participants.length;
};

// ─── Shared contract: both stores must behave the same for callers ───

const stores: Array<[name: string, make: () => PollStore]> = [
  ["file", () => createFilePollStore(tempFile())],
  ["blob", () => createBlobPollStore(new MemoryBlobClient())],
];

describe.each(stores)("%s poll store contract", (_name, make) => {
  it("creates, reads, updates and deletes one poll at a time", async () => {
    const store = make();
    await expect(store.get("poll_a")).resolves.toBeNull();
    await expect(store.create(makePoll("poll_a"))).resolves.toBe(true);
    await expect(store.create(makePoll("poll_b"))).resolves.toBe(true);

    expect((await store.get("poll_a"))?.title).toBe("poll_a");
    expect((await store.getMany(["poll_b", "missing", "poll_a"])).map((poll) => poll.id)).toEqual(["poll_b", "poll_a"]);
    expect((await store.listIds()).sort()).toEqual(["poll_a", "poll_b"]);

    await expect(store.update("poll_a", (draft) => addParticipant(draft, "ada"))).resolves.toBe(1);
    expect((await store.get("poll_a"))?.participants).toHaveLength(1);
    expect((await store.get("poll_b"))?.participants).toHaveLength(0);

    await store.delete("poll_a");
    await store.delete("poll_a");
    await expect(store.get("poll_a")).resolves.toBeNull();
    expect(await store.listIds()).toEqual(["poll_b"]);
  });

  it("skips the write when the updater returns null, and reports a missing poll as null", async () => {
    const store = make();
    await store.create(makePoll("poll_a"));
    await expect(store.update("poll_a", (draft) => {
      draft.title = "discarded";
      return null;
    })).resolves.toBeNull();
    expect((await store.get("poll_a"))?.title).toBe("poll_a");

    let called = false;
    await expect(store.update("poll_missing", () => (called = true))).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it("treats a replayed create as success but refuses a different poll with the same id", async () => {
    const store = make();
    const poll = makePoll("poll_a");
    await expect(store.create(poll)).resolves.toBe(true);
    await expect(store.create(structuredClone(poll))).resolves.toBe(true);
    await expect(store.create({ ...poll, title: "impostor" })).resolves.toBe(false);
    expect((await store.get("poll_a"))?.title).toBe("poll_a");
    expect(await store.listIds()).toEqual(["poll_a"]);
  });

  it("never hands out state that can change the stored poll", async () => {
    const store = make();
    await store.create(makePoll("poll_a"));
    const loaded = await store.get("poll_a");
    loaded!.title = "changed outside store";
    const draftResult = await store.update("poll_a", (draft) => draft);
    draftResult!.title = "changed through a result";
    expect((await store.get("poll_a"))?.title).toBe("poll_a");
  });

  it("treats ids outside the public id format as missing", async () => {
    const store = make();
    await expect(store.get("../polls")).resolves.toBeNull();
    await expect(store.getMany(["a/b"])).resolves.toEqual([]);
    await expect(store.update("a/b", () => true)).resolves.toBeNull();
  });

  it("keeps every change from 12 concurrent writers on the same poll", async () => {
    const store = make();
    await store.create(makePoll("poll_busy"));
    const names = Array.from({ length: 12 }, (_, i) => `writer${i}`);
    const results = await Promise.all(names.map((name) => store.update("poll_busy", (draft) => addParticipant(draft, name))));
    expect(results.every((count) => typeof count === "number")).toBe(true);
    const stored = await store.get("poll_busy");
    expect(stored!.participants.map((p) => p.name).sort()).toEqual([...names].sort());
  });

  it("keeps every change from 12 concurrent writers on different polls", async () => {
    const store = make();
    const ids = Array.from({ length: 12 }, (_, i) => `poll_${i}`);
    await Promise.all(ids.map((id) => store.create(makePoll(id))));
    await Promise.all(ids.map((id) => store.update(id, (draft) => addParticipant(draft, id))));
    const polls = await store.getMany(ids);
    expect(polls).toHaveLength(12);
    expect(polls.every((poll) => poll.participants.length === 1 && poll.participants[0].name === poll.id)).toBe(true);
  });

  it("rejects a write that would make one poll larger than the storage limit", async () => {
    const store = make();
    await store.create(makePoll("poll_big"));
    const huge = "x".repeat(MAX_POLL_BYTES);
    await expect(store.update("poll_big", (draft) => (draft.description = huge))).rejects.toBeInstanceOf(PollTooLargeError);
    await expect(store.create({ ...makePoll("poll_huge"), description: huge })).rejects.toMatchObject({ status: 413 });
    expect((await store.get("poll_big"))?.description).toBe("");
    await expect(store.get("poll_huge")).resolves.toBeNull();
  });
});

// ─── File store specifics ───

describe("file poll store", () => {
  it("keeps the single JSON array file format and skips writes that change nothing", async () => {
    const filePath = tempFile();
    const store = createFilePollStore(filePath);
    await store.create(makePoll("poll_first"));
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.map((poll: Poll) => poll.id)).toEqual(["poll_first"]);

    const before = fs.readFileSync(filePath, "utf8");
    await store.update("poll_first", () => null);
    await store.delete("poll_missing");
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("fails closed on malformed JSON and never replaces it with an empty array", async () => {
    const filePath = tempFile();
    const malformed = "{ definitely not an array";
    fs.writeFileSync(filePath, malformed, "utf8");
    const store = createFilePollStore(filePath);

    await expect(store.get("poll_a")).rejects.toThrow();
    await expect(store.create(makePoll("poll_never"))).rejects.toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe(malformed);
  });
});

// ─── Blob store specifics ───

describe("blob poll store", () => {
  it("stores one blob per poll with strong reads and per-key conditional writes", async () => {
    const client = new MemoryBlobClient();
    const store = createBlobPollStore(client);
    await store.create(makePoll("poll_a"));
    await store.update("poll_a", (draft) => addParticipant(draft, "ada"));

    expect(client.keys()).toEqual(["poll/poll_a"]);
    expect(client.writeCalls[0]).toMatchObject({ key: "poll/poll_a", options: { onlyIfNew: true } });
    expect(client.writeCalls[1].options).toEqual({ onlyIfMatch: expect.stringMatching(/^etag-/) });
    expect(client.readCalls.at(-1)).toMatchObject({ key: "poll/poll_a", options: { type: "json", consistency: "strong" } });
  });

  it("retries a transient conflict with backoff but not a network error", async () => {
    const client = new MemoryBlobClient();
    const store = createBlobPollStore(client, { backoffMs: 1 });
    await store.create(makePoll("poll_a"));
    client.conflictsRemaining = 3;
    await expect(store.update("poll_a", (draft) => addParticipant(draft, "eventually"))).resolves.toBe(1);
    expect(client.writeCalls).toHaveLength(5);

    const networkError = new Error("network is down");
    client.writeError = networkError;
    await expect(store.update("poll_a", (draft) => addParticipant(draft, "never"))).rejects.toBe(networkError);
    expect(client.writeCalls).toHaveLength(6);
  });

  it("gives up with a retryable 409 after bounded attempts", async () => {
    const client = new MemoryBlobClient();
    const store = createBlobPollStore(client, { maxAttempts: 4, backoffMs: 1 });
    await store.create(makePoll("poll_a"));
    client.conflictsRemaining = 100;
    const failure = store.update("poll_a", (draft) => addParticipant(draft, "never"));
    await expect(failure).rejects.toBeInstanceOf(PollStoreConflictError);
    await expect(failure).rejects.toMatchObject({ statusCode: 409, retryable: true });
    expect(client.writeCalls).toHaveLength(5);
  });

  it("treats a create whose committed write reported a conflict as stored", async () => {
    const client = new MemoryBlobClient();
    const store = createBlobPollStore(client);
    client.commitThenReportConflict = true;
    await expect(store.create(makePoll("poll_a"))).resolves.toBe(true);
    expect(client.keys()).toEqual(["poll/poll_a"]);
  });

  it("fails closed on a corrupt poll blob", async () => {
    const client = new MemoryBlobClient();
    client.seed("poll/poll_a", ["not", "a poll"]);
    const store = createBlobPollStore(client);
    await expect(store.get("poll_a")).rejects.toThrow();
    await expect(store.update("poll_a", () => true)).rejects.toThrow();
    expect(client.writeCalls).toHaveLength(0);
  });

  it("lists ids across pages and ignores the legacy array key", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_old")]);
    const store = createBlobPollStore(client);
    await Promise.all(["poll_1", "poll_2", "poll_3"].map((id) => store.create(makePoll(id))));
    expect((await store.listIds()).sort()).toEqual(["poll_1", "poll_2", "poll_3"]);
  });

  it("imports kept polls from the legacy array, drops the rest, and deletes the array", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_keep"), makePoll("poll_drop"), makePoll("poll_taken")]);
    client.seed("poll/poll_taken", { ...makePoll("poll_taken"), title: "newer" });
    const store = createBlobPollStore(client);

    const result = await store.importLegacyPolls!((poll) => poll.id !== "poll_drop");
    expect(result).toEqual({ imported: 2, dropped: 1 });
    expect(client.keys()).toEqual(["poll/poll_keep", "poll/poll_taken"]);
    expect((await store.get("poll_taken"))?.title).toBe("newer");
    await expect(store.importLegacyPolls!(() => true)).resolves.toEqual({ imported: 0, dropped: 0 });
  });
});
