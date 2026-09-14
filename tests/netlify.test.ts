import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobsServer } from '@netlify/blobs/server';
import { getStore, setEnvironmentContext } from '@netlify/blobs';
import type { Context } from '@netlify/functions';

// A date inside the API's one-year window, whenever the suite runs.
const FUTURE_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const FUNCTION_FILE = path.resolve('netlify/functions/api.ts');
let emulator: BlobsServer;
let directory: string;
let address: string;
let siteNumber = 0;
const originalContext = globalThis.netlifyBlobsContext;
const originalEnvironmentContext = process.env.NETLIFY_BLOBS_CONTEXT;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-netlify-'));
  emulator = new BlobsServer({ directory, token: 'local-test-only', logger: () => {} });
  const server = await emulator.start();
  address = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
  vi.stubEnv('CONTEXT', 'production');
  // BlobsServer 11 emits ETags on PUT but omits them on GET. Restore those
  // same server-issued values only in this harness; production stays strict.
  const etags = new Map<string, string>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await realFetch(input, init);
    const url = String(input);
    const method = init?.method?.toUpperCase() ?? 'GET';
    const etag = response.headers.get('etag');
    if (method === 'PUT' && response.ok && etag) etags.set(url, etag);
    if (method === 'GET' && response.ok && !etag && etags.has(url)) {
      const headers = new Headers(response.headers);
      headers.set('etag', etags.get(url)!);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  });
  setEnvironmentContext({
    siteID: `site-${++siteNumber}`,
    token: 'local-test-only',
    edgeURL: address,
    uncachedEdgeURL: address,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  globalThis.netlifyBlobsContext = originalContext;
  if (originalEnvironmentContext === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT;
  else process.env.NETLIFY_BLOBS_CONTEXT = originalEnvironmentContext;
  await emulator?.stop();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

async function invoke(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  expect(fs.existsSync(FUNCTION_FILE), 'Deployable Netlify function exists').toBe(true);
  const { default: handler } = await import(/* @vite-ignore */ FUNCTION_FILE);
  const request = new Request(`https://calendar.example${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await handler(request, { requestId: 'test-request' } as Context) as Response;
}

describe('Netlify deployment contract', () => {
  it('publishes only the frontend and routes APIs to a bundled function', () => {
    expect(fs.existsSync('netlify.toml'), 'Explicit Netlify deployment configuration exists').toBe(true);
    const config = fs.readFileSync('netlify.toml', 'utf8');
    expect(config).toMatch(/publish\s*=\s*"dist"/);
    expect(config).toMatch(/functions\s*=\s*"netlify\/functions"/);
    expect(config).toMatch(/from\s*=\s*"\/api\/\*"/);
    expect(config).toMatch(/to\s*=\s*"\/\.netlify\/functions\/api\/:splat"/);
    expect(config).toMatch(/force\s*=\s*true/);
  });

  it.each(['/api/health', '/.netlify/functions/api/health'])(
    'serves health through the deployed function at %s', async (url) => {
      const response = await invoke('GET', url);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok' });
      expect(response.headers.get('cache-control')).toContain('no-store');
    },
  );

  it('persists creation and answers across requests using the real Blobs SDK', async () => {
    const created = await invoke('POST', '/api/polls', {
      title: 'Cloud scheduling test', dates: [FUTURE_DATE], durationMinutes: 45,
      startHour: 9, endHour: 10.5,
    });
    expect(created.status).toBe(201);
    const poll = await created.json();
    const answered = await invoke('POST', `/.netlify/functions/api/polls/${poll.id}/respond`, {
      name: 'Test participant', availability: { [`${FUTURE_DATE}T09:00`]: 'available', [`${FUTURE_DATE}T09:30`]: 'preferred' },
    });
    expect(answered.status).toBe(200);
    const reloaded = await invoke('GET', `/api/polls/${poll.id}?fresh=1`);
    expect(await reloaded.json()).toMatchObject({
      id: poll.id, durationMinutes: 45, participants: [{ name: 'Test participant' }],
    });
    const list = await invoke('GET', `/api/polls?ids=${poll.id}`);
    expect(await list.json()).toEqual([expect.objectContaining({ id: poll.id, participantsCount: 1 })]);
    const durable = await getStore({ name: 'calendar-polls', consistency: 'strong' }).get('polls', { type: 'json' });
    expect(durable).toEqual([expect.objectContaining({ id: poll.id, participants: [expect.objectContaining({ name: 'Test participant' })] })]);
  });

  it('passes organizer codes through the deployed function', async () => {
    const created = await (await invoke('POST', '/api/polls', { title: 'Guarded', dates: [FUTURE_DATE] })).json();
    expect(created.organizerCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await invoke('POST', `/api/polls/${created.id}/reset`)).status).toBe(403);
    const reset = await invoke('POST', `/api/polls/${created.id}/reset`, undefined, { 'X-Organizer-Code': created.organizerCode });
    expect(reset.status).toBe(200);
  });

  it('returns JSON validation and missing-route errors instead of an HTML fallback', async () => {
    const invalid = await invoke('POST', '/api/polls', {});
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Title is required.' });
    const missing = await invoke('GET', '/api/missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'API route not found' });
  });

  it('isolates preview data from the production store', async () => {
    vi.stubEnv('CONTEXT', 'deploy-preview');
    vi.stubEnv('DEPLOY_ID', 'preview-123');
    const created = await invoke('POST', '/api/polls', { title: 'Preview only', dates: [FUTURE_DATE] });
    expect(created.status).toBe(201);
    vi.stubEnv('CONTEXT', 'production');
    expect(await (await invoke('GET', `/api/polls/${(await created.json()).id}`)).status).toBe(404);
  });

  it('fails clearly without storage credentials, never falls back to a local file', async () => {
    setEnvironmentContext({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await invoke('POST', '/api/polls', { title: 'Cannot save', dates: [FUTURE_DATE] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Meeting storage is unavailable. Please try again later.' });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('runs a daily scheduled cleanup that deletes expired polls from Blobs', async () => {
    const cleanupFile = path.resolve('netlify/functions/cleanup-polls.ts');
    const { default: cleanup, config } = await import(/* @vite-ignore */ cleanupFile);
    expect(config).toEqual({ schedule: '@daily' });

    const store = getStore({ name: 'calendar-polls', consistency: 'strong' });
    const base = { description: '', durationMinutes: 30, timezone: 'UTC', startHour: 9, endHour: 10,
      slotInterval: 30, creatorName: 'Ada', createdAt: '', finalizedSlot: null, participants: [],
      organizerCodeHash: 'a'.repeat(64) };
    await store.setJSON('polls', [
      { ...base, id: 'expired', title: 'Expired', dates: ['2020-01-01'] },
      { ...base, id: 'kept', title: 'Kept', dates: ['2099-10-01'] },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await cleanup(new Request('https://calendar.example/.netlify/functions/cleanup-polls', {
      method: 'POST', body: JSON.stringify({ next_run: '2099-01-01T00:00:00Z' }),
    }));
    expect(response.status).toBe(204);
    const durable = await store.get('polls', { type: 'json' });
    expect(durable.map((p: { id: string }) => p.id)).toEqual(['kept']);
  });
});
