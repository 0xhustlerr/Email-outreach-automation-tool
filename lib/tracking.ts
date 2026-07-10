// Email open-tracking config + helpers. A shared Cloudflare Worker (see
// tracking-worker/) serves a 1x1 pixel and records opens; this module mints the
// per-send tokens, builds the pixel URL, and polls the Worker for opens.

import crypto from "crypto";
import { db } from "./db";

// Set this to your deployed Worker URL (e.g. https://open-tracking.you.workers.dev)
// to enable open tracking for ALL shipped installs by default. Leave empty to
// keep it opt-in per install (configured in Accounts → Open tracking).
const SHARED_TRACKING_URL = "https://open-tracking.yefryortiz65.workers.dev";

function metaGet(key: string): string | null {
  try {
    const r = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  } catch {
    return null;
  }
}

function metaSet(key: string, value: string): void {
  try {
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  } catch {
    // ignore
  }
}

/** Base URL of the tracking Worker (no trailing slash). '' = tracking disabled. */
export function getTrackingBaseUrl(): string {
  const raw =
    metaGet("tracking_base_url")?.trim() ||
    process.env.TRACKING_BASE_URL?.trim() ||
    SHARED_TRACKING_URL;
  return (raw || "").replace(/\/+$/, "");
}

export function setTrackingBaseUrl(url: string): void {
  metaSet("tracking_base_url", url.trim().replace(/\/+$/, ""));
}

/** Tracking is on only when a URL is set AND the toggle isn't turned off. */
export function isTrackingEnabled(): boolean {
  if (!getTrackingBaseUrl()) return false;
  const flag = metaGet("tracking_enabled");
  return flag === null ? true : flag === "1";
}

export function setTrackingEnabled(on: boolean): void {
  metaSet("tracking_enabled", on ? "1" : "0");
}

/** Stable per-install id (also the KV key prefix on the Worker). */
export function getInstallId(): string {
  const existing = metaGet("install_id");
  if (existing && existing.trim()) return existing.trim();
  const id = crypto.randomBytes(16).toString("base64url");
  metaSet("install_id", id);
  return id;
}

/** Opaque per-send token: `<installId>-<random>`. */
export function newTrackToken(): string {
  return `${getInstallId()}-${crypto.randomBytes(9).toString("base64url")}`;
}

/** Pixel URL for a token, or null when tracking is disabled. */
export function pixelUrl(token: string): string | null {
  const base = getTrackingBaseUrl();
  if (!base) return null;
  return `${base}/o/${encodeURIComponent(token)}.gif`;
}

export type OpenRecord = { token: string; count: number; first: number; last: number };

/** Poll the Worker for this install's opens. */
export async function fetchOpens(sinceMs = 0): Promise<OpenRecord[]> {
  const base = getTrackingBaseUrl();
  if (!base) return [];
  const id = getInstallId();
  const url =
    `${base}/opens?ik=${encodeURIComponent(id)}` +
    (sinceMs ? `&since=${sinceMs}` : "");
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`opens fetch failed (${res.status})`);
  const data = (await res.json()) as { ok?: boolean; opens?: OpenRecord[] };
  return Array.isArray(data.opens) ? data.opens : [];
}

export function isTrackingUrlSet(): boolean {
  return !!getTrackingBaseUrl();
}
