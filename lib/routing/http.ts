/**
 * Small HTTP helpers for routing providers: typed errors, timeouts, a polite
 * User-Agent and a tiny in-memory cache with in-flight de-duplication.
 */

/** An error that maps cleanly to an HTTP status + ApiError body. */
export class PlanError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export const APP_VERSION = "0.1";
const DEFAULT_CONTACT = "+https://github.com/willyclayton/only-trains";

/**
 * Transitous requires a User-Agent with app name, version and contact
 * (https://transitous.org/api/) and rejects generic ones with 403.
 */
export function userAgent(): string {
  const contact = (process.env.ONLY_TRAINS_CONTACT || "").trim().replace(/[\r\n()]/g, "");
  return contact
    ? `OnlyTrains/${APP_VERSION} (${DEFAULT_CONTACT}; ${contact})`
    : `OnlyTrains/${APP_VERSION} (${DEFAULT_CONTACT})`;
}

export type FetchResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; text: string };

/** fetch() with an AbortSignal timeout; network/timeout failures throw PlanError(502/504). */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number; provider: string },
): Promise<Response> {
  const { timeoutMs, provider, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal, cache: "no-store" });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError" || ac.signal.aborted) {
      throw new PlanError(504, `${provider} timed out`, `No answer within ${Math.round(timeoutMs / 1000)} s. Try again in a moment.`);
    }
    throw new PlanError(502, `${provider} is unreachable`, err.message || String(err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tiny TTL cache (per server instance). Protects the free community API from
// duplicate requests (React strict-mode double effects, quick toggles, paging
// back and forth) without any external store.
// ---------------------------------------------------------------------------

type Entry<T> = { at: number; ttl: number; value: Promise<T> };
const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 200;

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const value = fn();
  store.set(key, { at: now, ttl: ttlMs, value });
  // failed lookups must not be cached
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  if (store.size > MAX_ENTRIES) {
    for (const [k, v] of store) {
      if (now - v.at >= v.ttl || store.size > MAX_ENTRIES) store.delete(k);
      if (store.size <= MAX_ENTRIES * 0.8) break;
    }
  }
  return value;
}
