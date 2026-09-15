import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Poll } from "../src/types";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_POLL_BYTES,
  MAX_POLL_DATES,
  MAX_TIMEZONE_LENGTH,
  MAX_TITLE_LENGTH,
} from "../src/utils/limits";
import { createBlobPollStore } from "../server/blob-store";
import {
  createFilePollStore,
  pollBytes,
  PollStoreConflictError,
  PollTooLargeError,
  type PollStore,
} from "../server/poll-store";
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

const datesFrom = (start: string, count: number) =>
  Array.from({ length: count }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

const ALL_DAY = Array.from({ length: 96 }, (_, i) =>
  `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
const STATUSES = ["available", "preferred", "if_needed", "unavailable"] as const;
// JSON escapes a control character as \u0001: six bytes per character, the most any character costs.
const widest = (length: number) => "\u0001".repeat(length);

/** Every date and 15-minute slot answered by every response, every text at its limit. */
function fullAvailability(dates: string[], offset = 0) {
  return Object.fromEntries(dates.flatMap((date, d) =>
    ALL_DAY.map((time, t) => [`${date}T${time}`, STATUSES[(d + t + offset) % STATUSES.length]])));
}

function worstCasePoll(id: string): Poll {
  const dates = datesFrom("2027-01-01", MAX_POLL_DATES);
  return {
    ...makePoll(id),
    title: widest(MAX_TITLE_LENGTH),
    description: widest(MAX_DESCRIPTION_LENGTH),
    location: widest(MAX_LOCATION_LENGTH),
    durationMinutes: 480,
    timezone: widest(MAX_TIMEZONE_LENGTH),
    dates,
    startHour: 0,
    endHour: 24,
    slotInterval: 15,
    proposedSlots: Object.fromEntries(dates.map((date) => [date, ALL_DAY])),
    creatorName: widest(MAX_NAME_LENGTH),
    creatorEmail: widest(MAX_EMAIL_LENGTH),
    createdAt: new Date(0).toISOString(),
    finalizedSlot: {
      date: dates[0], startTime: "00:00", endTime: "08:00",
      confirmedBy: widest(MAX_NAME_LENGTH), confirmedAt: new Date(0).toISOString(),
    },
    participants: Array.from({ length: MAX_PARTICIPANTS }, (_, i) => ({
      id: `part_${String(i).padStart(22, "x")}`,
      name: widest(MAX_NAME_LENGTH),
      email: widest(MAX_EMAIL_LENGTH),
      timezone: widest(MAX_TIMEZONE_LENGTH),
      updatedAt: new Date(0).toISOString(),
      availability: fullAvailability(dates, i),
      editCodeHash: "f".repeat(64),
    })),
  };
}

/** A stored poll whose one participant carries raw compact slots. */
const withSlots = (id: string, slots: Record<string, string>) => ({
  ...makePoll(id),
  participants: [{ id: "part_a", name: "Ada", timezone: "UTC", updatedAt: "", slots }],
});

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

  it("stores the largest valid poll: 60 full days, 200 fully answered responses, every text field at its limit", async () => {
    const store = make();
    const poll = worstCasePoll("poll_worst");
    expect(pollBytes(poll)).toBeLessThanOrEqual(MAX_POLL_BYTES);
    await expect(store.create(poll)).resolves.toBe(true);
    const stored = await store.get("poll_worst");
    expect(stored).toEqual(poll);
  }, 30_000);

  it("reads availability back exactly as it was saved", async () => {
    const store = make();
    const poll = makePoll("poll_codec");
    poll.participants.push({
      id: "part_a", name: "Ada", timezone: "UTC", updatedAt: "",
      availability: {
        "2027-01-01T00:00": "available",
        "2027-01-01T09:15": "preferred",
        "2027-01-01T23:45": "if_needed",
        "2027-01-02T12:30": "unavailable",
      },
    });
    await store.create(poll);
    expect(await store.get("poll_codec")).toEqual(poll);
    await store.update("poll_codec", (draft) => (draft.participants[0].availability["2027-01-01T10:00"] = "available"));
    expect((await store.get("poll_codec"))!.participants[0].availability).toEqual({
      ...poll.participants[0].availability,
      "2027-01-01T10:00": "available",
    });
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

  it("reads verbose availability from older files and writes it compactly", async () => {
    const filePath = tempFile();
    const verbose = makePoll("poll_old");
    verbose.participants.push({
      id: "part_a", name: "Ada", timezone: "UTC", updatedAt: "", availability: { "2027-01-01T00:30": "preferred" },
    });
    fs.writeFileSync(filePath, JSON.stringify([verbose]), "utf8");
    const store = createFilePollStore(filePath);
    expect(await store.get("poll_old")).toEqual(verbose);

    await store.update("poll_old", (draft) => (draft.title = "touched"));
    const [onDisk] = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk.participants[0].slots).toEqual({ "2027-01-01": "..p" });
    expect(onDisk.participants[0].availability).toBeUndefined();
    expect((await createFilePollStore(filePath).get("poll_old"))?.participants[0].availability)
      .toEqual({ "2027-01-01T00:30": "preferred" });
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
    expect(result).toEqual({ imported: 2, dropped: 1, skipped: 0 });
    expect(client.keys()).toEqual(["poll/poll_keep", "poll/poll_taken"]);
    expect((await store.get("poll_taken"))?.title).toBe("newer");
    await expect(store.importLegacyPolls!(() => true)).resolves.toEqual({ imported: 0, dropped: 0, skipped: 0 });
  });

  it("skips and counts malformed legacy entries instead of giving up on the whole array", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a"), null, ["nope"], { id: 7 }, withSlots("poll_bad", { "2027-01-01": "zz" }), makePoll("poll_b")]);
    const store = createBlobPollStore(client);
    await expect(store.importLegacyPolls!(() => true)).resolves.toEqual({ imported: 2, dropped: 0, skipped: 4 });
    expect(client.keys()).toEqual(["poll/poll_a", "poll/poll_b"]);
  });

  it("does not resurrect a legacy poll deleted while the import runs", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a"), makePoll("poll_b")]);
    const store = createBlobPollStore(client);
    // The organizer deletes poll_a right after the import has read the array.
    const read = client.getWithMetadata.bind(client);
    let deleted = false;
    client.getWithMetadata = async (key, options) => {
      const result = await read(key, options);
      if (key === "polls" && !deleted) {
        deleted = true;
        await store.delete("poll_a");
      }
      return result;
    };
    await expect(store.importLegacyPolls!(() => true)).resolves.toEqual({ imported: 1, dropped: 0, skipped: 0 });
    client.getWithMetadata = read;
    await expect(store.get("poll_a")).resolves.toBeNull();
    expect(client.keys()).toEqual(["poll/poll_b"]);
  });

  // ─── Storage format ───

  it("stores availability as one compact string per answered date", async () => {
    const client = new MemoryBlobClient();
    const store = createBlobPollStore(client);
    const poll = makePoll("poll_a");
    poll.participants.push({
      id: "part_a", name: "Ada", timezone: "UTC", updatedAt: "",
      availability: { "2027-01-01T00:15": "available", "2027-01-01T00:45": "preferred", "2027-01-02T00:00": "unavailable" },
    });
    await store.create(poll);
    const stored = client.peek("poll/poll_a") as { participants: Array<Record<string, unknown>> };
    expect(stored.participants[0].availability).toBeUndefined();
    expect(stored.participants[0].slots).toEqual({ "2027-01-01": ".a.p", "2027-01-02": "u" });
    expect(await store.get("poll_a")).toEqual(poll);
  });

  it("reads the verbose availability format and rewrites it compactly on the next write", async () => {
    const client = new MemoryBlobClient();
    const verbose = makePoll("poll_old");
    verbose.participants.push({
      id: "part_a", name: "Ada", timezone: "UTC", updatedAt: "", availability: { "2027-01-01T09:00": "if_needed" },
    });
    client.seed("poll/poll_old", verbose);
    const store = createBlobPollStore(client);
    expect(await store.get("poll_old")).toEqual(verbose);
    await store.update("poll_old", (draft) => (draft.title = "touched"));
    const stored = client.peek("poll/poll_old") as { participants: Array<Record<string, unknown>> };
    expect(stored.participants[0]).toMatchObject({ slots: { "2027-01-01": ".".repeat(36) + "i" } });
    expect(stored.participants[0].availability).toBeUndefined();
  });

  it("fails closed on a corrupt compact availability string", async () => {
    const client = new MemoryBlobClient();
    client.seed("poll/poll_bad", withSlots("poll_bad", { "2027-01-01": "a".repeat(97) }));
    await expect(createBlobPollStore(client).get("poll_bad")).rejects.toThrow();
  });

  it("never lets edits that grow responses push a valid poll over the size limit", async () => {
    const client = new MemoryBlobClient();
    client.jitterMs = 0;
    const store = createBlobPollStore(client);
    const poll = worstCasePoll("poll_growing");
    const full = poll.participants.map((participant) => participant.availability);
    const lockedSlot = poll.finalizedSlot;
    for (const participant of poll.participants) participant.availability = {};
    poll.finalizedSlot = null;
    await store.create(poll);
    // Responses grow from empty to every slot answered, a batch at a time.
    for (let start = 0; start < full.length; start += 50) {
      await expect(store.update("poll_growing", (draft) => {
        for (let i = start; i < Math.min(start + 50, full.length); i += 1) draft.participants[i].availability = full[i];
        return true;
      })).resolves.toBe(true);
    }
    // Then everyone changes every answer, and the organizer locks a time.
    await expect(store.update("poll_growing", (draft) => {
      draft.participants.forEach((participant, i) => (participant.availability = fullAvailability(poll.dates, i + 1)));
      draft.finalizedSlot = lockedSlot;
      return true;
    })).resolves.toBe(true);
  }, 60_000);

  // ─── Legacy array read window ───

  it("serves polls still in the legacy array until they are moved", async () => {
    const client = new MemoryBlobClient();
    const legacy = makePoll("poll_legacy");
    legacy.participants.push({ id: "part_a", name: "Ada", timezone: "UTC", updatedAt: "", availability: { "2027-01-01T09:00": "available" } });
    client.seed("polls", [legacy, makePoll("poll_other")]);
    const store = createBlobPollStore(client);
    await store.create(makePoll("poll_new"));

    expect(await store.get("poll_legacy")).toEqual(legacy);
    expect((await store.getMany(["poll_new", "poll_legacy", "poll_missing", "poll_other"])).map((poll) => poll.id))
      .toEqual(["poll_new", "poll_legacy", "poll_other"]);
    await expect(store.get("poll_missing")).resolves.toBeNull();
    expect(client.writeCalls.filter((call) => call.key === "polls")).toHaveLength(0);
  });

  it("prefers a poll's own blob over a stale legacy copy", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [{ ...makePoll("poll_a"), title: "stale" }]);
    client.seed("poll/poll_a", { ...makePoll("poll_a"), title: "current" });
    expect((await createBlobPollStore(client).get("poll_a"))?.title).toBe("current");
  });

  it("reads the legacy array once for a whole list request", async () => {
    const client = new MemoryBlobClient();
    const ids = Array.from({ length: 20 }, (_, i) => `poll_${i}`);
    client.seed("polls", ids.map(makePoll));
    const store = createBlobPollStore(client);
    expect(await store.getMany(ids)).toHaveLength(20);
    expect(client.readCalls.filter((call) => call.key === "polls")).toHaveLength(1);
  });

  it("moves a legacy poll into its own blob on the first write and drops it from the array", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a"), makePoll("poll_b")]);
    const store = createBlobPollStore(client);

    await expect(store.update("poll_a", (draft) => addParticipant(draft, "ada"))).resolves.toBe(1);
    expect(client.writeCalls[0]).toMatchObject({ key: "poll/poll_a", options: { onlyIfNew: true } });
    expect((client.peek("polls") as Poll[]).map((poll) => poll.id)).toEqual(["poll_b"]);
    expect((await store.get("poll_a"))?.participants).toHaveLength(1);

    // Later writes are ordinary per-poll writes.
    await expect(store.update("poll_a", (draft) => addParticipant(draft, "bob"))).resolves.toBe(2);
    expect(client.writeCalls.at(-1)?.options).toEqual({ onlyIfMatch: expect.stringMatching(/^etag-/) });
  });

  it("moves a legacy poll exactly once when the committed move reports a conflict", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a")]);
    const store = createBlobPollStore(client, { backoffMs: 1 });
    client.commitThenReportConflict = true;
    // Idempotent like a replayed save with the same edit code.
    const result = await store.update("poll_a", (draft) => {
      if (!draft.participants.some((p) => p.name === "ada")) addParticipant(draft, "ada");
      return draft.participants.length;
    });
    expect(result).toBe(1);
    expect((client.peek("poll/poll_a") as Poll).participants).toHaveLength(1);
    // The array copy may linger (cleanup removes it); the poll's own blob wins.
    expect((await store.get("poll_a"))?.participants).toHaveLength(1);
  });

  it("keeps two concurrent first writes to a legacy poll", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a")]);
    const store = createBlobPollStore(client, { backoffMs: 1 });
    const other = createBlobPollStore(client, { backoffMs: 1 });
    await Promise.all([
      store.update("poll_a", (draft) => addParticipant(draft, "ada")),
      other.update("poll_a", (draft) => addParticipant(draft, "bob")),
    ]);
    expect((await store.get("poll_a"))!.participants.map((p) => p.name).sort()).toEqual(["ada", "bob"]);
  });

  it("still succeeds when dropping a moved poll from the legacy array loses a race", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a")]);
    const store = createBlobPollStore(client);
    const write = client.setJSON.bind(client);
    client.setJSON = async (key, data, options) => (key === "polls" ? { modified: false } : write(key, data, options));
    await expect(store.update("poll_a", (draft) => addParticipant(draft, "ada"))).resolves.toBe(1);
    expect((client.peek("poll/poll_a") as Poll).participants).toHaveLength(1);
    expect(await store.listIds()).toEqual(["poll_a"]);
  });

  it("deletes a poll from its blob and from the legacy array", async () => {
    const client = new MemoryBlobClient();
    client.seed("polls", [makePoll("poll_a"), makePoll("poll_b")]);
    client.seed("poll/poll_a", makePoll("poll_a"));
    const store = createBlobPollStore(client);
    await expect(store.get("poll_b")).resolves.not.toBeNull();

    await store.delete("poll_a");
    await store.delete("poll_b");
    await expect(store.get("poll_a")).resolves.toBeNull();
    await expect(store.get("poll_b")).resolves.toBeNull();
    expect(client.peek("polls")).toEqual([]);
    expect(client.keys()).toEqual(["polls"]);
  });

});
