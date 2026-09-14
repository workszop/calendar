import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type express from "express";

// ─── Capability codes ───
// No accounts: whoever holds a code may act. The server stores only a SHA-256
// hash, so a leaked storage blob never grants access.

/** Header carrying the organizer code for a poll. */
export const ORGANIZER_HEADER = "x-organizer-code";
/** Header carrying a participant's edit code for their own response. */
export const EDIT_HEADER = "x-edit-code";

/** 24 random bytes as base64url: 32 URL-safe characters, 192 bits. */
export function newCode(): string {
  return randomBytes(24).toString("base64url");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Constant-time check of a presented code against a stored hash. */
export function codeMatches(code: string | undefined, storedHash: string | undefined): boolean {
  if (!code || !storedHash || code.length > 128) return false;
  const presented = Buffer.from(hashCode(code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/** A single-valued header as a trimmed string, or undefined. */
export function readCodeHeader(req: express.Request, header: string): string | undefined {
  const value = req.headers[header];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
