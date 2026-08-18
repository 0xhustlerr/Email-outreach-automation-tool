import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import { getSettings } from "@/lib/queue-store";
import {
  displayName,
  enqueueSequence,
  senderVars,
  urlVars,
} from "@/lib/sequences-store";
import {
  candidatesForEmails,
  listHistoryCandidates,
  type HistoryCandidate,
} from "@/lib/history-campaign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

// Preview: how many unique contacts match the range + filter.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const onlyNonReplied = url.searchParams.get("onlyNonReplied") !== "0";
  if (!from || !to) {
    return NextResponse.json({ ok: false, error: "from/to required." }, { status: 400 });
  }
  const count = listHistoryCandidates(from, to, onlyNonReplied).length;
  return NextResponse.json({ ok: true, count });
}

function pickCandidates(body: {
  emails?: string[];
  from?: string;
  to?: string;
  onlyNonReplied?: boolean;
}): HistoryCandidate[] {
  // Explicit per-email selection wins; otherwise fall back to the date range.
  if (Array.isArray(body.emails) && body.emails.length > 0) {
    return candidatesForEmails(body.emails);
  }
  return listHistoryCandidates(
    (body.from ?? "").trim(),
    (body.to ?? "").trim(),
    body.onlyNonReplied !== false,
  );
}

// Enqueue a two-step sequence for every history contact in the range, reusing
// each contact's stored name/url and ORIGINAL sender. Re-sends are allowed
// (that's the whole point), so the send-log dedup is bypassed.
export async function POST(req: Request) {
  markUserActivity();
  let body: {
    emails?: string[];
    from?: string;
    to?: string;
    onlyNonReplied?: boolean;
    // A single opener, or several to ROTATE across contacts (round-robin) so no
    // one template's text is sent too many times a day (spam-fingerprint guard).
    opener?: { subject?: string; body?: string };
    openers?: { subject?: string; body?: string }[];
    followUp?: { body?: string };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  // Normalize to a rotation list (falls back to the single opener field).
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
    return NextResponse.json(
      { ok: false, error: "At least one opener (subject + body) is required." },
      { status: 400 },
    );
  }

  const settings = getSettings();
  const fuBody = body.followUp?.body ?? "";
  const hasFollow = !!fuBody.trim();

  const candidates: HistoryCandidate[] = pickCandidates(body);
  if (candidates.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No contacts selected." },
      { status: 400 },
    );
  }

  let added = 0;
  const skipped: { email: string; reason: string }[] = [];
  candidates.forEach((c, i) => {
    const vars = {
      name: displayName(c.name),
      ...senderVars(),
      ...urlVars({ upwork: c.link, username: c.username }),
    };
    // Round-robin the opener across contacts so each template is used evenly.
    // FIFO drip + even assignment => ~(dailyCap / openerCount) sends per
    // template per day.
    const op = openerList[i % openerList.length];
    const res = enqueueSequence(
      {
        toEmail: c.email,
        fromEmail: c.sender, // reuse the address the contact already knows
        name: c.name,
        link: c.link,
        country: c.country,
        username: c.username,
        opSubject: substitute(op.subject, vars),
        opBody: substitute(op.body, vars),
        followUp: hasFollow
          ? { subject: "", body: substitute(fuBody, vars) }
          : undefined,
      },
      settings.startAt,
      { allowResend: true },
    );
    if ("skipped" in res) skipped.push({ email: c.email, reason: res.reason });
    else added++;
  });

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    added,
    skipped: skipped.length,
  });
}
