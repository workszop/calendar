import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercises the documented start command and real built assets, not a mock app.
let child: ChildProcess | undefined;
let tmpDir: string;
let base: string;
let logs = '';
const request = (url: string) => fetch(base + url, { signal: AbortSignal.timeout(2000) });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-synch-production-'));
  const port = 32000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), POLLS_DATA_FILE: path.join(tmpDir, 'polls.json') };
  delete env.NODE_ENV;
  child = spawn('/bin/bash', ['-c', scripts.start], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (data) => { logs += data; });
  child.stderr?.on('data', (data) => { logs += data; });
  let startError: Error | undefined;
  child.on('error', (error) => { startError = error; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (startError) throw startError;
    if (child.exitCode !== null) throw new Error(`Production start exited: ${logs}`);
    if (logs.includes('Server running')) {
      const res = await request('/api/health');
      if (res.ok) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Production start timed out: ${logs}`);
}, 10000);

afterAll(async () => {
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    process.kill(-child.pid, 'SIGTERM');
    await exited;
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('production deployment', () => {
  it('starts without NODE_ENV and serves the compiled app, not Vite development', async () => {
    const res = await request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('/@vite/client');
    expect(html).toMatch(/\/assets\/index-[^" ]+\.js/);
    expect(res.headers.get('cache-control')).toContain('no-cache');
  });

  it.each(['/server.cjs', '/server.cjs.map', '/src/App.tsx', '/@vite/client', '/assets/missing.js'])(
    'does not expose source or return HTML for missing assets: %s', async (url) => {
      expect((await request(url)).status).toBe(404);
    }
  );

  it('caches fingerprinted assets immutably', async () => {
    const html = await (await request('/')).text();
    const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
    expect(asset).toBeTruthy();
    const res = await request(asset!);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('cache-control')).toContain('max-age=31536000');
  });

  it('returns JSON for unknown APIs rather than the SPA shell', async () => {
    const res = await request('/api/missing');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });
});
