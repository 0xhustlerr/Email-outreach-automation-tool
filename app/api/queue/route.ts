import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import { getSettings, saveSettings, type QueueSettings } from "@/lib/queue-store";
import {
  backfillSequenceLocations,
  cancelAllPendingFollowups,
  cancelAllQueued,
  cancelSequence,
  cancelSequenceByEmail,
  clearFinishedSequences,
  enqueueSequence,
  listSequences,
  retryAllFailed,
  retrySequence,
  rotateQueuedOpeners,
  sequenceCounts,
} from "@/lib/sequences-store";
import { queueWorkerStatus } from "@/lib/queue-worker";
import { pauseSenderManually, resumeSender } from "@/lib/sender-blocks";
import { scanBouncesNow } from "@/lib/bounce-watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  markUserActivity();
  return NextResponse.json({
    ok: true,
    items: listSequences(),
    counts: sequenceCounts(),
    settings: getSettings(),
    status: queueWorkerStatus(),
  });
}

// Enqueue one or many two-step sequences for the scheduled drip.
export async function POST(req: Request) {
  markUserActivity();
  let body: {
    items?: {
      toEmail?: string;
      ccEmail?: string;
      fromEmail?: string;
      name?: string;
      link?: string;
      linkLinkedin?: string;
      linkGithub?: string;
      username?: string;
      country?: string;
      commitOffsetMin?: number | null;
      phones?: string[];
      subject?: string; // opener
      body?: string; // opener
      followUp?: { subject?: string; body?: string; delayMin?: number };
    }[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const settings = getSettings();
  const items = body.items ?? [];
  let added = 0;
  const skipped: { toEmail: string; reason: string }[] = [];

  for (const it of items) {
    const toEmail = (it.toEmail ?? "").trim();
    const subject = it.subject ?? "";
    const bodyText = it.body ?? "";
    if (!toEmail || !subject.trim() || !bodyText.trim()) {
      skipped.push({ toEmail, reason: "missing to/subject/body" });
      continue;
    }
    const fu = it.followUp;
    const hasFollow = !!fu && !!(fu.body ?? "").trim();
    const res = enqueueSequence(
      {
        toEmail,
        ccEmail: it.ccEmail ?? "",
        fromEmail: it.fromEmail ?? "",
        name: it.name,
        link: it.link,
        linkLinkedin: it.linkLinkedin,
        linkGithub: it.linkGithub,
        username: it.username,
        country: it.country,
        commitOffsetMin: it.commitOffsetMin,
        phones: it.phones,
        opSubject: subject.trim(),
        opBody: bodyText,
        followUp: hasFollow
          ? {
              subject: (fu!.subject ?? "").trim(),
              body: fu!.body ?? "",
              delayMin:
                Number(fu!.delayMin) > 0 ? Number(fu!.delayMin) : settings.fuDelayMin,
            }
          : undefined,
      },
      settings.startAt,
    );
    if ("skipped" in res) skipped.push({ toEmail, reason: res.reason });
    else added++;
  }

  return NextResponse.json({ ok: true, added, skipped, counts: sequenceCounts() });
}

export async function PATCH(req: Request) {
  markUserActivity();
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "cancel") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "id required." }, { status: 400 });
    }
    return NextResponse.json({ ok: cancelSequence(id), counts: sequenceCounts() });
  }

  // Manual retry of a failed (or canceled) item — the worker's own retry is
  // terminal after 3 attempts, so this is the only way back.
  if (action === "retry") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "id required." }, { status: 400 });
    }
    const res = retrySequence(id);
    return NextResponse.json({
      ok: res.ok,
      ...(res.ok ? { step: res.step } : { error: res.reason }),
      counts: sequenceCounts(),
    });
  }

  if (action === "retry-all-failed") {
    const res = retryAllFailed();
    return NextResponse.json({ ok: true, ...res, counts: sequenceCounts() });
  }

  if (action === "cancel-email") {
    const email = url.searchParams.get("email") ?? "";
    if (!email.trim()) {
      return NextResponse.json({ ok: false, error: "email required." }, { status: 400 });
    }
    const canceled = cancelSequenceByEmail(email);
    return NextResponse.json({ ok: canceled > 0, canceled, counts: sequenceCounts() });
  }

  // Lift a Gmail block before its automatic next-midnight expiry ("Resume now").
  // The resume holds for the rest of the local day: further bounces from the
  // same account won't silently re-pause it, so this can't flap.
  if (action === "resume-sender") {
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ ok: false, error: "email required." }, { status: 400 });
    }
    const resumed = resumeSender(email);
    return NextResponse.json({ ok: true, resumed, status: queueWorkerStatus() });
  }

  // Manual pause — also the way to exercise the whole feature without waiting
  // for a real bounce.
  if (action === "pause-sender") {
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ ok: false, error: "email required." }, { status: 400 });
    }
    pauseSenderManually(email);
    return NextResponse.json({ ok: true, status: queueWorkerStatus() });
  }

  // Force an immediate inbox scan instead of waiting for the 2-minute loop.
  if (action === "scan-bounces") {
    const result = await scanBouncesNow();
    return NextResponse.json({ ok: true, ...result, status: queueWorkerStatus() });
  }

  if (action === "clear-finished") {
    return NextResponse.json({ ok: true, removed: clearFinishedSequences() });
  }

  if (action === "cancel-all-queued") {
    const canceled = cancelAllQueued();
    return NextResponse.json({ ok: true, canceled, counts: sequenceCounts() });
  }

  if (action === "cancel-all-followups") {
    const canceled = cancelAllPendingFollowups();
    return NextResponse.json({ ok: true, canceled, counts: sequenceCounts() });
  }

  if (action === "backfill-locations") {
    return NextResponse.json({ ok: true, resolved: backfillSequenceLocations() });
  }

  if (action === "rotate-openers") {
    let payload: { openers?: { subject?: string; body?: string }[] };
    try {
      payload = (await req.json()) as typeof payload;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Request body must be JSON." },
        { status: 400 },
      );
    }
    const openers = (payload.openers ?? [])
      .map((o) => ({ subject: (o.subject ?? "").trim(), body: o.body ?? "" }))
      .filter((o) => o.subject && o.body.trim());
    if (openers.length === 0) {
      return NextResponse.json(
        { ok: false, error: "At least one opener is required." },
        { status: 400 },
      );
    }
    const updated = rotateQueuedOpeners(openers);
    return NextResponse.json({ ok: true, updated, counts: sequenceCounts() });
  }

  let patch: Partial<QueueSettings>;
  try {
    patch = (await req.json()) as Partial<QueueSettings>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, settings: saveSettings(patch) });
}
