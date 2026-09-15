import type { Server } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlobPollStore } from "../server/blob-store";
import { createApi } from "../server/api";
import { MemoryBlobClient } from "./memory-blob-client";

// A date inside the API's one-year window, whenever the suite runs.
const FUTURE_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

const start = async (app: ReturnType<typeof createApi>) => {
  const server = await new Promise<Server>((resolve, reject) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
    next.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not expose a TCP address.");
  return { server, base: `http://127.0.0.1:${address.port}` };
};

const stop = async (server: Server) => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const request = async (
  base: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {}
) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
};

const createBody = (title: string) => ({
  title,
  dates: [FUTURE_DATE],
  durationMinutes: 30,
  timezone: "UTC",
  creatorName: "Organizer",
});

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(stop));
});

describe("cloud PollStore API", () => {
  it("keeps concurrent creates from two independent API clients", async () => {
    const client = new MemoryBlobClient();
    const first = await start(createApi(createBlobPollStore(client)));
    const second = await start(createApi(createBlobPollStore(client)));
    openServers.push(first.server, second.server);

    const [one, two] = await Promise.all([
      request(first.base, "POST", "/api/polls", createBody("First")),
      request(second.base, "POST", "/api/polls", createBody("Second")),
    ]);
    expect(one.response.status).toBe(201);
    expect(two.response.status).toBe(201);

    const listed = await request(first.base, "GET", `/api/polls?ids=${one.json.id},${two.json.id}`);
    expect(listed.response.status).toBe(200);
    expect(listed.json.map((poll: { title: string }) => poll.title).sort()).toEqual(["First", "Second"]);
  });

  it("keeps concurrent answers to one poll from many API instances", async () => {
    const client = new MemoryBlobClient();
    const apis = await Promise.all(Array.from({ length: 4 }, () => start(createApi(createBlobPollStore(client)))));
    openServers.push(...apis.map((api) => api.server));
    const created = await request(apis[0].base, "POST", "/api/polls", createBody("Busy"));
    const pollId = created.json.id as string;

    const saves = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      request(apis[i % apis.length].base, "POST", `/api/polls/${pollId}/respond`, {
        name: `Person ${i}`,
        availability: { [`${FUTURE_DATE}T09:00`]: "available" },
      })
    ));
    expect(saves.map((save) => save.response.status)).toEqual(Array(12).fill(200));
    const reloaded = await request(apis[0].base, "GET", `/api/polls/${pollId}`);
    expect(reloaded.json.participants).toHaveLength(12);
    expect(client.keys()).toEqual([`poll/${pollId}`]);
  });

  it("answers persistent contention with a retryable 409, and other 409s without the flag", async () => {
    const client = new MemoryBlobClient();
    const api = await start(createApi(createBlobPollStore(client, { maxAttempts: 2, backoffMs: 1 })));
    openServers.push(api.server);
    const created = await request(api.base, "POST", "/api/polls", createBody("Contended"));
    const pollId = created.json.id as string;
    const organizer = { "X-Organizer-Code": created.json.organizerCode as string };

    client.conflictsRemaining = 10;
    const contended = await request(api.base, "POST", `/api/polls/${pollId}/respond`, { name: "Ada", availability: {} });
    expect(contended.response.status).toBe(409);
    expect(contended.json).toEqual({ error: expect.any(String), retryable: true });

    client.conflictsRemaining = 0;
    await request(api.base, "POST", `/api/polls/${pollId}/finalize`, {
      date: FUTURE_DATE, startTime: "09:00", endTime: "09:30",
    }, organizer);
    const locked = await request(api.base, "POST", `/api/polls/${pollId}/finalize`, {
      date: FUTURE_DATE, startTime: "10:00", endTime: "10:30",
    }, organizer);
    expect(locked.response.status).toBe(409);
    expect(locked.json.retryable).toBeUndefined();
  });

  it("does not duplicate a create when a committed CAS write reports a conflict", async () => {
    const client = new MemoryBlobClient();
    client.commitThenReportConflict = true;
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);

    const created = await request(api.base, "POST", "/api/polls", createBody("Exactly once"));
    expect(created.response.status).toBe(201);
    const listed = await request(api.base, "GET", `/api/polls?ids=${created.json.id}`);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].title).toBe("Exactly once");
  });

  it("does not duplicate a first answer when a committed CAS write reports a conflict", async () => {
    const client = new MemoryBlobClient();
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);
    const created = await request(api.base, "POST", "/api/polls", createBody("Answered once"));
    const pollId = created.json.id as string;

    client.commitThenReportConflict = true;
    const saved = await request(api.base, "POST", `/api/polls/${pollId}/respond`, { name: "Ada", availability: {} });
    expect(saved.response.status).toBe(200);
    expect(saved.json.poll.participants).toHaveLength(1);
    expect(saved.json.editCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const stored = client.peek(`poll/${pollId}`) as { participants: unknown[] };
    expect(stored.participants).toHaveLength(1);
  });

  it("supports the full lifecycle through a blob-backed API", async () => {
    const client = new MemoryBlobClient();
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);

    const created = await request(api.base, "POST", "/api/polls", createBody("Lifecycle"));
    expect(created.response.status).toBe(201);
    const pollId = created.json.id as string;
    const organizer = { "X-Organizer-Code": created.json.organizerCode as string };
    const response = await request(api.base, "POST", `/api/polls/${pollId}/respond`, {
      name: "Ada",
      availability: { [`${FUTURE_DATE}T09:00`]: "preferred" },
    });
    expect(response.response.status).toBe(200);
    const participantId = response.json.participant.id as string;

    const finalized = await request(api.base, "POST", `/api/polls/${pollId}/finalize`, {
      date: FUTURE_DATE,
      startTime: "09:00",
      endTime: "09:30",
    }, organizer);
    expect(finalized.response.status).toBe(200);
    expect(finalized.json.finalizedSlot.startTime).toBe("09:00");
    expect((await request(api.base, "POST", `/api/polls/${pollId}/reset`, undefined, organizer)).response.status).toBe(200);
    expect(
      (await request(api.base, "DELETE", `/api/polls/${pollId}/respond/${participantId}`, undefined, organizer)).response.status
    ).toBe(200);
  });

  it("returns no-store on reads and JSON 500 when the blob read fails", async () => {
    const client = new MemoryBlobClient();
    client.readError = new Error("blob transport unavailable");
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { response, json } = await request(api.base, "GET", "/api/polls?ids=poll_x");
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(json).toEqual({ error: "Internal server error" });
    } finally {
      log.mockRestore();
    }
  });

  it("keeps no-store on malformed API requests handled by the JSON parser", async () => {
    const api = await start(createApi(createBlobPollStore(new MemoryBlobClient())));
    openServers.push(api.server);
    const response = await fetch(`${api.base}/api/polls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ malformed",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
