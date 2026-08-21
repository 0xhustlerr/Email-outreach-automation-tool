// Bulk lead import: take parsed CSV rows, filter by region, find the contact's
// best current email from their GitHub footprint, and queue a two-step sequence
// for each survivor. Streams NDJSON progress (same shape as /api/scan) because a
// hundred leads means a hundred rounds of GitHub calls.

import { markUserActivity } from "@/lib/avatar-prefetch";
import { decideCountry, isTargetRegion } from "@/lib/country";
import { GitHubError, parseGitHubUsername } from "@/lib/github";
import { discoverLeadEmails } from "@/lib/lead-discovery";
import { getSettings } from "@/lib/queue-settings-store";
import {
  displayName,
  enqueueSequence,
  senderVars,
  urlVars,
} from "@/lib/sequences-store";
import type { CsvLead } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Leads processed at once. GitHub's authenticated limit is 5000/h and each lead
// costs ~8-10 requests, so 2 in flight keeps a big import comfortably inside it
// while still being ~2x faster than serial.
const CONCURRENCY = 2;
const MAX_ROWS = 2000;

type RowStatus = "queued" | "skipped" | "failed";

type RowEvent = {
  type: "row";
  index: number;
  total: number;
  name: string;
  githubUrl: string;
  login: string;
  status: RowStatus;
  email?: string;
  cc?: string;
  score?: number;
  country?: string;
  countrySource?: string;
  /** Every scored address, so the log can explain the pick. */
  candidates?: { email: string; score: number; reasons: string[] }[];
  reason?: string;
};

type ImportEvent =
  | { type: "start"; total: number }
  | RowEvent
  | { type: "done"; queued: number; skipped: number; failed: number }
  | { type: "error"; message: string };

type Body = {
  rows?: CsvLead[];
  /** One opener, or several to rotate round-robin across the leads. */
  opener?: { subject?: string; body?: string };
  openers?: { subject?: string; body?: string }[];
  followUp?: { subject?: string; body?: string };
  /** '' (default) lets the queue worker rotate senders. */
  fromEmail?: string;
};

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Everything for one lead except the actual enqueue (which must be serialized
 *  so two workers can't both slip past the duplicate check). */
async function resolveLead(
  lead: CsvLead,
): Promise<
  | { ok: false; login: string; reason: string }
  | {
      ok: true;
      login: string;
      country: string;
      countrySource: string;
      discovery: Awaited<ReturnType<typeof discoverLeadEmails>>;
    }
> {
  const login = parseGitHubUsername(lead.githubUrl);
  if (!login) return { ok: false, login: "", reason: "unreadable GitHub URL" };

  // Fast path: a CSV country we can already reject saves the whole GitHub round
  // trip. Without one we have to discover first — the profile location and any
  // phone number are what decide it.
  const fromCsv = decideCountry({ csvCountry: lead.country });
  if (fromCsv && !isTargetRegion(fromCsv.country)) {
    return { ok: false, login, reason: `outside target region (${fromCsv.country})` };
  }

  const discovery = await discoverLeadEmails(login);

  const decided =
    fromCsv ??
    decideCountry({
      githubLocation: discovery.location,
      phones: discovery.phones,
    });
  if (!decided) return { ok: false, login, reason: "country unknown" };
  if (!isTargetRegion(decided.country)) {
    return { ok: false, login, reason: `outside target region (${decided.country})` };
  }
  if (!discovery.choice.best) {
    return { ok: false, login, reason: discovery.choice.reason || "no email found" };
  }

  return {
    ok: true,
    login,
    country: decided.country,
    countrySource: decided.source,
    discovery,
  };
}

export async function POST(req: Request) {
  markUserActivity();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "Request body must be JSON.");
  }

  const rows = (body.rows ?? []).filter((r) => r && typeof r.githubUrl === "string");
  if (rows.length === 0) return jsonError(400, "No rows to import.");
  if (rows.length > MAX_ROWS) {
    return jsonError(400, `Too many rows (max ${MAX_ROWS}).`);
  }

  const rawOpeners =
    Array.isArray(body.openers) && body.openers.length > 0
      ? body.openers
      : body.opener
        ? [body.opener]
        : [];
  const openerList = rawOpeners
    .map((o) => ({ subject: (o.subject ?? "").trim(), body: o.body ?? "" }))
    .filter((o) => o.subject && o.body.trim());
  if (openerList.length === 0) {
    return jsonError(400, "At least one opener (subject + body) is required.");
  }

  const settings = getSettings();
  const fuBody = body.followUp?.body ?? "";
  const hasFollow = !!fuBody.trim();
  const fuSubject = (body.followUp?.subject ?? "").trim();
  const fromEmail = (body.fromEmail ?? "").trim();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ImportEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      send({ type: "start", total: rows.length });

      let queued = 0;
      let skipped = 0;
      let failed = 0;
      let aborted = false;
      // Openers rotate by lead position so each template is used evenly.
      let openerCursor = 0;
      let cursor = 0;

      const runOne = async (lead: CsvLead, index: number) => {
        const base = {
          type: "row" as const,
          index,
          total: rows.length,
          name: lead.name,
          githubUrl: lead.githubUrl,
        };
        try {
          const resolved = await resolveLead(lead);
          if (!resolved.ok) {
            skipped++;
            send({
              ...base,
              login: resolved.login,
              status: "skipped",
              reason: resolved.reason,
            });
            return;
          }

          const { discovery, country, countrySource, login } = resolved;
          const best = discovery.choice.best!;
          const cc = discovery.choice.cc;
          const vars = {
            name: displayName(lead.name || discovery.name),
            ...senderVars(),
            ...urlVars({
              upwork: lead.upworkUrl,
              linkedin: lead.linkedinUrl,
              github: lead.githubUrl,
              username: login,
            }),
          };
          const opener = openerList[openerCursor++ % openerList.length];

          const res = enqueueSequence(
            {
              toEmail: best.email,
              ccEmail: cc?.email ?? "",
              fromEmail,
              name: lead.name || discovery.name,
              link: lead.upworkUrl,
              linkLinkedin: lead.linkedinUrl,
              linkGithub: lead.githubUrl,
              username: login,
              country,
              commitOffsetMin: discovery.commitOffsetMin,
              phones: discovery.phones,
              opSubject: substitute(opener.subject, vars),
              opBody: substitute(opener.body, vars),
              followUp: hasFollow
                ? {
                    subject: substitute(fuSubject, vars),
                    body: substitute(fuBody, vars),
                  }
                : undefined,
            },
            settings.startAt,
          );

          const candidates = discovery.choice.candidates.map((c) => ({
            email: c.email,
            score: c.score,
            reasons: c.reasons,
          }));

          if ("skipped" in res) {
            skipped++;
            send({
              ...base,
              login,
              status: "skipped",
              email: best.email,
              score: best.score,
              country,
              countrySource,
              candidates,
              reason: res.reason,
            });
            return;
          }

          queued++;
          send({
            ...base,
            login,
            status: "queued",
            email: best.email,
            cc: cc?.email,
            score: best.score,
            country,
            countrySource,
            candidates,
          });
        } catch (err) {
          // A rate limit is fatal for the whole run — every remaining lead would
          // fail the same way, so stop and tell the user. Only the first worker
          // to notice reports it; the others just wind down.
          if (err instanceof GitHubError && err.rateLimited) {
            if (!aborted) {
              aborted = true;
              send({ type: "error", message: err.message });
            }
            return;
          }
          failed++;
          send({
            ...base,
            login: "",
            status: "failed",
            reason: err instanceof Error ? err.message : "discovery failed",
          });
        }
      };

      const worker = async () => {
        for (;;) {
          if (aborted) return;
          const i = cursor++;
          if (i >= rows.length) return;
          await runOne(rows[i], i + 1);
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker),
        );
        if (!aborted) send({ type: "done", queued, skipped, failed });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Import failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
