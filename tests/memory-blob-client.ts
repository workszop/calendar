import type { BlobClient } from "../server/blob-store";

// ─── In-memory Netlify Blobs stand-in ───
// Per-key ETags and conditional writes like the real Store. Every call yields
// for a random moment, so concurrent writers genuinely interleave.

type WriteOptions = { onlyIfMatch?: string; onlyIfNew?: boolean };

export class MemoryBlobClient implements BlobClient {
  private readonly blobs = new Map<string, { data: unknown; etag: string }>();
  private version = 0;
  readCalls: Array<{ key: string; options: unknown }> = [];
  writeCalls: Array<{ key: string; data: unknown; options: WriteOptions }> = [];
  deleteCalls: string[] = [];
  /** Conditional writes that report `modified: false` without writing. */
  conflictsRemaining = 0;
  /** The next write commits but reports `modified: false`, like a lost response. */
  commitThenReportConflict = false;
  writeError: Error | undefined;
  readError: Error | undefined;
  /** Upper bound of the random delay per call, in ms. */
  jitterMs = 2;

  private tick() {
    return new Promise((resolve) => setTimeout(resolve, Math.random() * this.jitterMs));
  }

  /** Raw stored value, for assertions. */
  peek(key: string): unknown {
    return structuredClone(this.blobs.get(key)?.data);
  }

  keys(): string[] {
    return [...this.blobs.keys()].sort();
  }

  /** Writes a blob directly, bypassing conditions (fixtures). */
  seed(key: string, data: unknown) {
    this.version += 1;
    this.blobs.set(key, { data: structuredClone(data), etag: `etag-${this.version}` });
  }

  async getWithMetadata(key: string, options: unknown) {
    this.readCalls.push({ key, options });
    await this.tick();
    if (this.readError) throw this.readError;
    const blob = this.blobs.get(key);
    return blob ? { data: structuredClone(blob.data), etag: blob.etag, metadata: {} } : null;
  }

  async setJSON(key: string, data: unknown, options: WriteOptions) {
    this.writeCalls.push({ key, data: structuredClone(data), options });
    await this.tick();
    if (this.writeError) throw this.writeError;
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      return { modified: false };
    }
    const current = this.blobs.get(key);
    if (options.onlyIfNew && current) return { modified: false };
    if (options.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false };
    this.seed(key, data);
    if (this.commitThenReportConflict) {
      this.commitThenReportConflict = false;
      return { modified: false };
    }
    return { modified: true, etag: this.blobs.get(key)!.etag };
  }

  async delete(key: string) {
    this.deleteCalls.push(key);
    await this.tick();
    this.blobs.delete(key);
  }

  list(options: { prefix: string; paginate: true }): AsyncIterable<{ blobs: Array<{ key: string }> }> {
    const keys = this.keys().filter((key) => key.startsWith(options.prefix));
    return (async function* pages() {
      // Two pages, so callers must follow pagination.
      const half = Math.ceil(keys.length / 2);
      yield { blobs: keys.slice(0, half).map((key) => ({ key })) };
      yield { blobs: keys.slice(half).map((key) => ({ key })) };
    })();
  }
}
