import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import { isSendConfigured } from "@/lib/mail";
import { performSend } from "@/lib/send-core";
import { recordSentSequence } from "@/lib/sequences-store";
import { recordSendEvent } from "@/lib/recent-sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  from?: { email?: string; name?: string };
  to?: string;
  subject?: string;
  body?: string;
  name?: string;
  link?: string;
  linkLinkedin?: string;
  linkGithub?: string;
  username?: string;
  country?: string;
  // Location signals for scheduling (stored on the sequence).
  commitOffsetMin?: number | null;
  phones?: string[];
  // Optional follow-up (message 2). When present, the opener is sent now and
  // the follow-up is scheduled as a threaded reply after `delayMin`.
  followUp?: { subject?: string; body?: string; delayMin?: number };
};

export async function POST(req: Request) {
  markUserActivity();
  if (!isSendConfigured()) {
    return NextResponse.json(
      {
        error:
          "No sending account configured. Add one in Accounts with its app password.",
      },
      { status: 503 },
    );
  }

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  // Send the opener immediately (this is the visible, synchronous result).
  const result = await performSend({
    to: parsed.to ?? "",
    subject: parsed.subject ?? "",
    body: parsed.body ?? "",
    fromEmail: parsed.from?.email ?? "",
    fromName: parsed.from?.name ?? "",
    name: parsed.name,
    link: parsed.link,
    linkLinkedin: parsed.linkLinkedin,
    linkGithub: parsed.linkGithub,
    username: parsed.username,
    country: parsed.country,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  recordSendEvent(
    parsed.to ?? "",
    parsed.followUp ? "opener" : "single",
    result.sender,
  );

  // Record the sequence and schedule the follow-up (if any) as a threaded
  // reply. The background engine fires it when the delay elapses.
  // Follow-up subject is derived (Re: opener) at send time, so only its body
  // is required here.
  const fu = parsed.followUp;
  const hasFollow = !!fu && !!(fu.body ?? "").trim();
  recordSentSequence({
    toEmail: parsed.to ?? "",
    fromEmail: result.sender,
    name: parsed.name,
    link: parsed.link,
    linkLinkedin: parsed.linkLinkedin,
    linkGithub: parsed.linkGithub,
    username: parsed.username,
    country: parsed.country,
    commitOffsetMin: parsed.commitOffsetMin,
    phones: parsed.phones,
    opSubject: (parsed.subject ?? "").trim(),
    opBody: parsed.body ?? "",
    opMessageId: result.messageId,
    followUp: hasFollow
      ? {
          subject: (fu!.subject ?? "").trim(),
          body: fu!.body ?? "",
          delayMin: Number(fu!.delayMin) > 0 ? Number(fu!.delayMin) : 30,
        }
      : undefined,
  });

  return NextResponse.json({
    ok: true,
    messageId: result.messageId,
    followUpScheduled: hasFollow,
  });
}
