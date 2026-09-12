import type { Server } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlobPollStore } from "../server/blob-store";
import { createApi } from "../server/api";

class MemoryBlobClient {
  data: unknown = undefined;
  exists = false;
  version = 0;
  readError: Error | undefined;
  holdInitialReads = false;
  commitThenReportConflict = false;
  private readonly pendingInitialReads: Array<(value: null) => void> = [];

  private etag() {
    return `etag-${this.version}`;
  }

  async getWithMetadata() {
    if (this.readError) throw this.readError;
    if (!this.exists) {
      if (this.holdInitialReads && this.pendingInitialReads.length < 2) {
        return new Promise<null>((resolve) => {
          this.pendingInitialReads.push(resolve);
          if (this.pendingInitialReads.length === 2) {
            for (const release of this.pendingInitialReads.splice(0)) release(null);
          }
        });
      }
      return null;
    }
    return { data: structuredClone(this.data), etag: this.etag(), metadata: {} };
  }

  async setJSON(_key: string, data: unknown, options?: { onlyIfMatch?: string; onlyIfNew?: boolean }) {
    if (options?.onlyIfNew && this.exists) return { modified: false };
    if (options?.onlyIfMatch && (!this.exists || options.onlyIfMatch !== this.etag())) return { modified: false };
    this.exists = true;
    this.data = structuredClone(data);
    this.version += 1;
    if (this.commitThenReportConflict) {
      this.commitThenReportConflict = false;
      return { modified: false };
    }
    return { modified: true, etag: this.etag() };
  }
}

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

const request = async (base: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
};

const createBody = (title: string) => ({
  title,
  dates: ["2027-03-01"],
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
    client.holdInitialReads = true;
    const first = await start(createApi(createBlobPollStore(client)));
    const second = await start(createApi(createBlobPollStore(client)));
    openServers.push(first.server, second.server);

    const [one, two] = await Promise.all([
      request(first.base, "POST", "/api/polls", createBody("First")),
      request(second.base, "POST", "/api/polls", createBody("Second")),
    ]);
    expect(one.response.status).toBe(201);
    expect(two.response.status).toBe(201);

    const listed = await request(first.base, "GET", "/api/polls");
    expect(listed.response.status).toBe(200);
    expect(listed.json.map((poll: { title: string }) => poll.title).sort()).toEqual(["First", "Second"]);
  });

  it("does not duplicate a create when a committed CAS write reports a conflict", async () => {
    const client = new MemoryBlobClient();
    client.commitThenReportConflict = true;
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);

    const created = await request(api.base, "POST", "/api/polls", createBody("Exactly once"));
    expect(created.response.status).toBe(201);
    const listed = await request(api.base, "GET", "/api/polls");
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].title).toBe("Exactly once");
  });

  it("supports the full lifecycle through a blob-backed API", async () => {
    const client = new MemoryBlobClient();
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);

    const created = await request(api.base, "POST", "/api/polls", createBody("Lifecycle"));
    expect(created.response.status).toBe(201);
    const pollId = created.json.id as string;
    const response = await request(api.base, "POST", `/api/polls/${pollId}/respond`, {
      name: "Ada",
      availability: { "2027-03-01T09:00": "preferred" },
    });
    expect(response.response.status).toBe(200);
    const participantId = response.json.participant.id as string;

    const finalized = await request(api.base, "POST", `/api/polls/${pollId}/finalize`, {
      date: "2027-03-01",
      startTime: "09:00",
      endTime: "09:30",
    });
    expect(finalized.response.status).toBe(200);
    expect(finalized.json.finalizedSlot.startTime).toBe("09:00");
    expect((await request(api.base, "POST", `/api/polls/${pollId}/reset`)).response.status).toBe(200);
    expect((await request(api.base, "DELETE", `/api/polls/${pollId}/respond/${participantId}`)).response.status).toBe(200);
  });

  it("returns no-store on reads and JSON 500 when the blob read fails", async () => {
    const client = new MemoryBlobClient();
    client.readError = new Error("blob transport unavailable");
    const api = await start(createApi(createBlobPollStore(client)));
    openServers.push(api.server);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { response, json } = await request(api.base, "GET", "/api/polls");
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
