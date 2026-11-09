// GlockApps spam-test API v2 provider (https://glockapps.com/api-documentation-v2/,
// Swagger at docs.spamtest.prod-k8s.glockapps.com/swagger.json).
//
// Flow: POST manualTest → GlockApps returns its seed list plus a header and a
// body line that tie our message to the test → we send ONE message to all
// seeds → poll GET tests?testId= until `finished`.
//
// Parsing is deliberately lenient: the Swagger leaves several response shapes
// undocumented (only "Inbox"/"Spam" are shown for iType, and gappsFlags has
// no fixed shape), so unknowns map to "pending" until the test finishes.

import { getGlockAppsSettings } from "@/lib/identities-store";
import {
  sentAtMs,
  type Placement,
  type PlacementProvider,
  type PlacementResultRow,
  type PlacementTestRow,
  type ResultUpdate,
} from "./types";

export const GLOCKAPPS_BASE = "https://api.glockapps.com/gateway/spamtest-v2/api";

/** Give up waiting on a test GlockApps never marks finished. */
const GIVE_UP_AFTER_MS = 2 * 60 * 60_000;

async function gaFetch(apiKey: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${GLOCKAPPS_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const o = (data ?? {}) as { message?: string; error?: string; errors?: unknown };
    const msg =
      (typeof o.message === "string" && o.message) ||
      (typeof o.error === "string" && o.error) ||
      (typeof data === "string" && data.slice(0, 200)) ||
      `HTTP ${res.status}`;
    throw new Error(
      res.status === 401 || res.status === 403
        ? `GlockApps rejected the API key (${msg}). API access needs a paid or pay-per-test plan.`
        : `GlockApps: ${msg}`,
    );
  }
  return data;
}

/** Unwrap GlockApps' `{ result: … }` envelope when present. */
function unwrap(data: unknown): Record<string, unknown> {
  const o = (data ?? {}) as Record<string, unknown>;
  const r = o.result;
  return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : o;
}

/** "X-API-Campaign-id: 2023-…t" → { "X-API-Campaign-id": "2023-…t" } */
export function parseInsertHeader(raw: unknown): Record<string, string> {
  if (typeof raw !== "string") return {};
  const i = raw.indexOf(":");
  if (i <= 0) return {};
  const name = raw.slice(0, i).trim();
  const value = raw.slice(i + 1).trim();
  return name && value && /^[A-Za-z0-9-]+$/.test(name) ? { [name]: value } : {};
}

export type GlockAppsProject = { id: string; name: string };

/** Validates the key and lists the account's projects. */
export async function listGlockAppsProjects(apiKey: string): Promise<GlockAppsProject[]> {
  const data = await gaFetch(apiKey, "/projects");
  const o = (data ?? {}) as Record<string, unknown>;
  const arr = [o.result, o.results, o.projects, o.items, data].find(Array.isArray) as
    | Record<string, unknown>[]
    | undefined;
  return (arr ?? [])
    .map((p) => {
      const id = String(p.projectId ?? p.id ?? "").trim();
      const name = String(p.name ?? p.projectName ?? p.title ?? id).trim();
      return { id, name: name || id };
    })
    .filter((p) => p.id);
}

/** True when any gappsFlags entry says Promotions. The flags come either as
 *  an object of booleans or as an array of names. */
function flagsSayPromotions(flags: unknown): boolean {
  if (!flags) return false;
  const names: string[] = Array.isArray(flags)
    ? flags.map((f) => (typeof f === "string" ? f : JSON.stringify(f)))
    : typeof flags === "object"
      ? Object.entries(flags as Record<string, unknown>)
          .filter(([, v]) => v === true || v === "true" || v === 1)
          .map(([k]) => k)
      : [];
  return names.some((n) => /promotion/i.test(n));
}

/** One GlockApps `inboxes[]` entry → our placement (null = not known yet). */
export function mapGlockAppsInbox(entry: Record<string, unknown>): {
  placement: Placement;
  detail: string;
} | null {
  const iType = String(entry.iType ?? "").trim().toLowerCase();
  if (iType === "spam") return { placement: "spam", detail: "" };
  if (iType === "inbox") {
    return flagsSayPromotions(entry.gappsFlags)
      ? { placement: "tab", detail: "Promotions" }
      : { placement: "inbox", detail: "" };
  }
  if (/promo|tab|categor/.test(iType)) return { placement: "tab", detail: String(entry.iType) };
  if (/not.?deliver|missing|absent/.test(iType)) {
    return { placement: "missing", detail: "Never arrived" };
  }
  return null;
}

/** Map a full GlockApps TestItem onto our pending seeds. */
export function mapGlockAppsResult(
  item: Record<string, unknown>,
  results: Pick<PlacementResultRow, "seed" | "placement">[],
  opts: { giveUp: boolean },
): { updates: ResultUpdate[]; finished: boolean } {
  const finished = item.finished === true || item.finished === "true" || opts.giveUp;
  const inboxes = Array.isArray(item.inboxes) ? (item.inboxes as Record<string, unknown>[]) : [];
  const updates: ResultUpdate[] = [];
  const seen = new Set<string>();

  for (const entry of inboxes) {
    const seed = String(entry.email ?? "").trim().toLowerCase();
    if (!seed) continue;
    seen.add(seed);
    const mapped = mapGlockAppsInbox(entry);
    const seedProvider = String(entry.seedName ?? entry.providerGroupId ?? "").trim();
    if (mapped) updates.push({ seed, seedProvider, ...mapped });
    else if (finished) {
      updates.push({ seed, seedProvider, placement: "missing", detail: "Never arrived" });
    }
  }

  if (finished) {
    for (const r of results) {
      if (r.placement === "pending" && !seen.has(r.seed)) {
        updates.push({ seed: r.seed, placement: "missing", detail: "Never arrived" });
      }
    }
  }
  return { updates, finished };
}

/** GlockApps settings as the API shows them — never the key. */
export function glockAppsPublicSettings(): {
  configured: boolean;
  projectId: string;
  providerGroupIds: string[];
} {
  const s = getGlockAppsSettings();
  return s
    ? { configured: true, projectId: s.projectId, providerGroupIds: s.providerGroupIds }
    : { configured: false, projectId: "", providerGroupIds: [] };
}

function settingsOrThrow() {
  const s = getGlockAppsSettings();
  if (!s) throw new Error("GlockApps isn't set up. Add your API key and project first.");
  return s;
}

export const glockAppsProvider: PlacementProvider = {
  id: "glockapps",
  label: "GlockApps",
  giveUpAfterMs: GIVE_UP_AFTER_MS,

  status() {
    return getGlockAppsSettings()
      ? { ok: true }
      : { ok: false, reason: "Add your GlockApps API key and project to use it." };
  },

  async prepare(sender) {
    const s = settingsOrThrow();
    const body: Record<string, unknown> = {
      testType: "ManualTest",
      note: `Outreach placement test: ${sender}`,
    };
    if (s.providerGroupIds.length > 0) body.providerGroupIds = s.providerGroupIds;
    const r = unwrap(
      await gaFetch(s.apiKey, `/projects/${encodeURIComponent(s.projectId)}/manualTest`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const testId = String(r.testId ?? "").trim();
    const emails = Array.isArray(r.emails)
      ? (r.emails as unknown[]).map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : [];
    if (!testId || emails.length === 0) {
      throw new Error("GlockApps created no test or returned no seed addresses.");
    }
    const insertInBody = typeof r.insertInBody === "string" ? r.insertInBody.trim() : "";
    return {
      externalId: testId,
      seeds: emails.map((email) => ({ email, provider: "" })),
      mode: "bcc",
      headers: parseInsertHeader(r.insertHeader),
      bodySuffix: insertInBody || `id: ${testId}`,
    };
  },

  async collect(test: PlacementTestRow, results: PlacementResultRow[]) {
    const s = settingsOrThrow();
    const item = unwrap(
      await gaFetch(
        s.apiKey,
        `/projects/${encodeURIComponent(s.projectId)}/tests?testId=${encodeURIComponent(test.external_id)}`,
      ),
    );
    return mapGlockAppsResult(item, results, {
      giveUp: Date.now() - sentAtMs(test) > GIVE_UP_AFTER_MS,
    });
  },

  // GlockApps refunds the point when a test is deleted before any email
  // arrives. The delete path is not in the public docs, so this is
  // best-effort and never blocks the failure being reported.
  async abort(test) {
    const s = getGlockAppsSettings();
    if (!s || !test.external_id) return;
    try {
      await gaFetch(
        s.apiKey,
        `/projects/${encodeURIComponent(s.projectId)}/tests/${encodeURIComponent(test.external_id)}`,
        { method: "DELETE" },
      );
    } catch {
      // ignore
    }
  },
};
