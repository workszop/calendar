import type express from "express";

// ─── Rate limiting ───
// A small in-memory fixed-window limiter, per client IP and per bucket. It runs
// inside one process (one server, or one warm Netlify function instance), so it
// slows down abuse rather than guaranteeing a global ceiling.

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitConfig {
  /** POST /api/polls. `false` disables the bucket. */
  create?: RateLimitRule | false;
  /** Every other mutating request. `false` disables the bucket. */
  write?: RateLimitRule | false;
}

/** Classroom-friendly: a class behind one school NAT shares a single IP. */
export const DEFAULT_RATE_LIMITS: Required<RateLimitConfig> = {
  create: { limit: 60, windowMs: 60 * 60 * 1000 },
  write: { limit: 600, windowMs: 10 * 60 * 1000 },
};

/** Tracked clients per bucket. Past it, the oldest windows are evicted first. */
export const DEFAULT_MAX_TRACKED_CLIENTS = 50_000;

export type ClientIp = (req: express.Request) => string;

/** Express's own view of the peer. `x-forwarded-for` is ignored unless the app sets "trust proxy". */
export const expressClientIp: ClientIp = (req) => req.ip || req.socket.remoteAddress || "unknown";

/** Netlify sets this header itself; the client cannot forge it behind the CDN. */
export const netlifyClientIp: ClientIp = (req) => {
  const value = req.headers["x-nf-client-connection-ip"];
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
};

// ─── Client keys ───

/** Eight hextets of an IPv6 address, or null when it is not one. */
function ipv6Hextets(address: string): string[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const hextets = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return hextets.every((part) => /^[0-9a-f]{1,4}$/.test(part)) ? hextets : null;
}

/**
 * The rate-limit key for a client address. One IPv6 subscriber usually gets a
 * whole /64, so IPv6 clients are grouped by it; IPv4-mapped IPv6 counts as IPv4.
 */
export function clientKey(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1];
  if (!address.includes(":")) return address;
  const hextets = ipv6Hextets(address);
  if (!hextets) return address;
  return `${hextets.slice(0, 4).map((part) => part.padStart(4, "0")).join(":")}::/64`;
}

// ─── Environment ───

/** Positive integer from the environment; 0 disables; anything else warns and falls back. */
function envLimit(env: NodeJS.ProcessEnv, name: string, windowMs: number): RateLimitRule | false | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) {
    console.warn(`${name}="${raw}" is not a whole number; using the default limit.`);
    return undefined;
  }
  const limit = Number(raw);
  return limit === 0 ? false : { limit, windowMs };
}

/** Limits from RATE_LIMIT_CREATE_PER_HOUR and RATE_LIMIT_WRITES_PER_10_MIN. Unset ones keep their defaults. */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const create = envLimit(env, "RATE_LIMIT_CREATE_PER_HOUR", 60 * 60 * 1000);
  const write = envLimit(env, "RATE_LIMIT_WRITES_PER_10_MIN", 10 * 60 * 1000);
  return { ...(create !== undefined ? { create } : {}), ...(write !== undefined ? { write } : {}) };
}

/**
 * Express "trust proxy" from TRUST_PROXY: unset or "false" is off, "true" trusts
 * every hop, a number trusts that many hops, anything else is passed on as
 * Express's address list, e.g. "loopback, 10.0.0.0/8".
 */
export function trustProxyFromEnv(value: string | undefined): boolean | number | string {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// ─── Limiter ───

export interface RateLimiter {
  /** Middleware for one bucket; a disabled bucket passes everything through. */
  middleware(bucket: keyof RateLimitConfig, clientIp: ClientIp): express.RequestHandler;
  /** Clients currently tracked in one bucket. */
  trackedClients(bucket: keyof RateLimitConfig): number;
}

export interface RateLimiterOptions {
  /** Most clients tracked per bucket. */
  maxClients?: number;
}

export function createRateLimiter(
  config: RateLimitConfig = {},
  now: () => number = Date.now,
  options: RateLimiterOptions = {}
): RateLimiter {
  const rules = { ...DEFAULT_RATE_LIMITS, ...config };
  const maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_TRACKED_CLIENTS);
  // Per bucket, clients in window-start order: a new window is re-inserted at
  // the end, so the oldest windows are always at the front.
  const windows = new Map<string, Map<string, { start: number; count: number }>>();
  const countersFor = (bucket: string) => {
    let counters = windows.get(bucket);
    if (!counters) {
      counters = new Map();
      windows.set(bucket, counters);
    }
    return counters;
  };

  return {
    middleware(bucket, clientIp) {
      const rule = rules[bucket];
      const counters = countersFor(bucket);

      return (req, res, next) => {
        if (!rule) return next();
        const time = now();
        // Amortized sweep: drop expired windows from the front only. Each entry
        // is removed at most once, so no request scans the whole map.
        for (const [key, entry] of counters) {
          if (time - entry.start < rule.windowMs) break;
          counters.delete(key);
        }

        const key = clientKey(clientIp(req));
        let entry = counters.get(key);
        if (!entry || time - entry.start >= rule.windowMs) {
          counters.delete(key);
          entry = { start: time, count: 0 };
          counters.set(key, entry);
          // Hard cap: evict the oldest windows first.
          for (const oldest of counters.keys()) {
            if (counters.size <= maxClients) break;
            counters.delete(oldest);
          }
        }
        entry.count += 1;
        if (entry.count <= rule.limit) return next();

        const retryAfter = Math.max(1, Math.ceil((entry.start + rule.windowMs - time) / 1000));
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      };
    },
    trackedClients(bucket) {
      return countersFor(bucket).size;
    },
  };
}
