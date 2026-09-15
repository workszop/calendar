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

export const DEFAULT_RATE_LIMITS: Required<RateLimitConfig> = {
  create: { limit: 10, windowMs: 60 * 60 * 1000 },
  write: { limit: 120, windowMs: 10 * 60 * 1000 },
};

/** Tracked clients per bucket before stale windows are swept. */
const SWEEP_THRESHOLD = 10_000;

export type ClientIp = (req: express.Request) => string;

/** Express's own view of the peer. `x-forwarded-for` is ignored unless the app sets "trust proxy". */
export const expressClientIp: ClientIp = (req) => req.ip || req.socket.remoteAddress || "unknown";

/** Netlify sets this header itself; the client cannot forge it behind the CDN. */
export const netlifyClientIp: ClientIp = (req) => {
  const value = req.headers["x-nf-client-connection-ip"];
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
};

export interface RateLimiter {
  /** Middleware for one bucket; a disabled bucket passes everything through. */
  middleware(bucket: keyof RateLimitConfig, clientIp: ClientIp): express.RequestHandler;
}

export function createRateLimiter(config: RateLimitConfig = {}, now: () => number = Date.now): RateLimiter {
  const rules = { ...DEFAULT_RATE_LIMITS, ...config };
  const windows = new Map<string, Map<string, { start: number; count: number }>>();

  return {
    middleware(bucket, clientIp) {
      const rule = rules[bucket];
      const counters = windows.get(bucket) ?? new Map<string, { start: number; count: number }>();
      windows.set(bucket, counters);

      return (req, res, next) => {
        if (!rule) return next();
        const time = now();
        if (counters.size > SWEEP_THRESHOLD) {
          for (const [key, entry] of counters) if (time - entry.start >= rule.windowMs) counters.delete(key);
        }

        const key = clientIp(req);
        let entry = counters.get(key);
        if (!entry || time - entry.start >= rule.windowMs) {
          entry = { start: time, count: 0 };
          counters.set(key, entry);
        }
        entry.count += 1;
        if (entry.count <= rule.limit) return next();

        const retryAfter = Math.max(1, Math.ceil((entry.start + rule.windowMs - time) / 1000));
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      };
    },
  };
}
