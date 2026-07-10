// Shared avatar resolution: disk cache → database cache → unavatar.io.
// Used by the /api/avatar route (on-demand) and lib/avatar-prefetch.ts (idle
// background prefetch). All upstream hits go through one throttled queue so
// the two callers can't combine to trip unavatar's per-IP rate limit.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAvatarFromDb, saveAvatarToDb } from "./db";

const DIR = path.join(process.cwd(), ".data", "avatars");

export type AvatarImage = { buf: Buffer; contentType: string };

/** ok → img set. no-avatar → definitive 404 (cacheable long-term).
 *  rate-limited / error → transient; must NOT be recorded as "no photo". */
export type AvatarFetchResult = {
  img: AvatarImage | null;
  status: "ok" | "no-avatar" | "rate-limited" | "error";
};

// Emails we recently failed to resolve → don't re-hammer unavatar for them.
const negativeCache = new Map<string, number>(); // email -> retry-after (ms epoch)
const inFlight = new Map<string, Promise<AvatarFetchResult>>();

// unavatar.io has a small DAILY quota per IP. When it answers 429 it sends
// Retry-After (often ~24h) - a global circuit breaker: stop calling it at
// all until then. Gravatar lookups are unaffected.
const globalForLimit = globalThis as unknown as {
  __unavatarLimitedUntil?: number;
};

export function unavatarLimitedUntilMs(): number {
  return globalForLimit.__unavatarLimitedUntil ?? 0;
}

function setUnavatarLimited(retryAfterHeader: string | null): void {
  const secs = Number(retryAfterHeader);
  const ms =
    Number.isFinite(secs) && secs > 0
      ? Math.min(secs, 24 * 3600) * 1000
      : 3600_000; // no header → assume an hour
  globalForLimit.__unavatarLimitedUntil = Date.now() + ms;
}

// unavatar.io rate-limits by IP; space upstream fetches out to stay under it.
const UPSTREAM_GAP_MS = 1_300;
type UpstreamQueue = { tail: Promise<void>; lastFetchMs: number };
const globalForQueue = globalThis as unknown as { __avatarQueue?: UpstreamQueue };
const queue: UpstreamQueue =
  globalForQueue.__avatarQueue ?? { tail: Promise.resolve(), lastFetchMs: 0 };
globalForQueue.__avatarQueue = queue;

function throttleUpstream<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.tail.then(async () => {
    const wait = queue.lastFetchMs + UPSTREAM_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    queue.lastFetchMs = Date.now();
    return fn();
  });
  queue.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function keyFor(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex");
}

function readDiskCache(email: string): AvatarImage | null {
  const file = path.join(DIR, keyFor(email));
  try {
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    const contentType = fs.existsSync(file + ".ct")
      ? fs.readFileSync(file + ".ct", "utf8")
      : "image/jpeg";
    return { buf, contentType };
  } catch {
    return null;
  }
}

/** Disk cache first, then the database copy. No network. */
export function getCachedAvatar(email: string): AvatarImage | null {
  const fromDisk = readDiskCache(email);
  if (fromDisk) return fromDisk;
  const fromDb = getAvatarFromDb(keyFor(email));
  return fromDb ? { buf: fromDb.data, contentType: fromDb.contentType } : null;
}

/** True while a recent failure says not to retry yet. */
export function isNegativeCached(email: string): boolean {
  const retryAfter = negativeCache.get(email);
  return !!retryAfter && retryAfter > Date.now();
}

function cacheAvatar(email: string, buf: Buffer, contentType: string): void {
  const file = path.join(DIR, keyFor(email));
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    fs.writeFileSync(file + ".ct", contentType);
  } catch {
    // best-effort disk cache
  }
  saveAvatarToDb({
    key: keyFor(email),
    email,
    contentType,
    data: buf,
    fetchedAt: new Date().toISOString(),
  });
}

// Gravatar has no practical rate limit and accepts sha256 hashes, so it's a
// free first chance before spending unavatar's small daily quota. Most Gmail
// photos still need unavatar (Google source), but every gravatar hit helps.
async function fetchFromGravatar(email: string): Promise<AvatarImage | null> {
  try {
    const res = await fetch(
      `https://gravatar.com/avatar/${keyFor(email)}?d=404&s=256`,
      { headers: { "User-Agent": "email-finder-avatar-proxy" } },
    );
    if (res.status !== 200) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, contentType: res.headers.get("content-type") || "image/jpeg" };
  } catch {
    return null;
  }
}

/** Try gravatar, then unavatar (throttled + circuit-broken). Caches hits on
 *  disk and in the database. Only status "no-avatar" is a definitive miss. */
export function fetchAvatarFromUpstream(
  email: string,
): Promise<AvatarFetchResult> {
  const existing = inFlight.get(email);
  if (existing) return existing;

  const job = (async (): Promise<AvatarFetchResult> => {
    try {
      const fromGravatar = await fetchFromGravatar(email);
      if (fromGravatar) {
        cacheAvatar(email, fromGravatar.buf, fromGravatar.contentType);
        return { img: fromGravatar, status: "ok" };
      }

      if (unavatarLimitedUntilMs() > Date.now()) {
        negativeCache.set(email, Date.now() + 60_000);
        return { img: null, status: "rate-limited" };
      }

      const res = await throttleUpstream(() =>
        fetch(`https://unavatar.io/${encodeURIComponent(email)}?fallback=false`, {
          headers: { "User-Agent": "email-finder-avatar-proxy" },
        }),
      );
      if (res.status === 200) {
        const buf = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") || "image/jpeg";
        cacheAvatar(email, buf, contentType);
        return { img: { buf, contentType }, status: "ok" };
      }
      if (res.status === 429) {
        setUnavatarLimited(res.headers.get("retry-after"));
        negativeCache.set(email, Date.now() + 60_000);
        return { img: null, status: "rate-limited" };
      }
      // Genuine no-photo - back off a while (but not so long that a
      // newly-added photo stays hidden all day).
      negativeCache.set(email, Date.now() + 30 * 60_000);
      return { img: null, status: "no-avatar" };
    } catch {
      negativeCache.set(email, Date.now() + 20_000);
      return { img: null, status: "error" };
    } finally {
      inFlight.delete(email);
    }
  })();

  inFlight.set(email, job);
  return job;
}
