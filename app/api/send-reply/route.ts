import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  getGmailMessageReplyHeaders,
  isGmailReplySyncConfigured,
} from "@/lib/gmail";
import { isSendConfigured, listIdentities, sendMail } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  from?: { email?: string; name?: string };
  to?: string;
  body?: string;
  /** Gmail API message id to reply to (from thread). */
  replyToMessageId?: string;
  /** Inbox that received the thread (for Gmail header lookup). */
  sender?: string;
};

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re:";
  if (/^re:\s*/i.test(s)) return s;
  return `Re: ${s}`;
}

export async function POST(req: Request) {
  if (!isSendConfigured()) {
    return NextResponse.json(
      {
        error:
          "No sending account configured. Add one in Accounts (app password or Gmail OAuth).",
      },
      { status: 503 },
    );
  }

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const to = (parsed.to ?? "").trim();
  const body = parsed.body ?? "";
  const fromEmail = (parsed.from?.email ?? "").trim();
  const fromName = (parsed.from?.name ?? "").trim();
  const replyToMessageId = (parsed.replyToMessageId ?? "").trim();
  const senderInbox = (parsed.sender ?? fromEmail).trim();

  if (!to || !isValidEmail(to)) {
    return NextResponse.json(
      { error: "Recipient email is invalid." },
      { status: 400 },
    );
  }
  if (!body.trim()) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }
  if (!fromEmail || !isValidEmail(fromEmail)) {
    return NextResponse.json(
      { error: "Sender email is invalid." },
      { status: 400 },
    );
  }
  if (!replyToMessageId) {
    return NextResponse.json(
      { error: "replyToMessageId is required." },
      { status: 400 },
    );
  }

  const identities = listIdentities();
  const match = identities.find(
    (i) => i.email.toLowerCase() === fromEmail.toLowerCase(),
  );
  if (!match) {
    return NextResponse.json(
      { error: "Sender email is not in MAIL_IDENTITIES." },
      { status: 400 },
    );
  }

  let inReplyTo: string | undefined;
  let references: string | undefined;
  let subject = "Re:";

  if (isGmailReplySyncConfigured() && senderInbox) {
    try {
      const headers = await getGmailMessageReplyHeaders(
        senderInbox,
        replyToMessageId,
      );
      if (headers) {
        inReplyTo = headers.messageId;
        references = headers.references;
        subject = replySubject(headers.subject);
      }
    } catch {
      // Fall back to generic Re: if Gmail headers unavailable.
    }
  }

  try {
    const info = await sendMail({
      from: { name: fromName || match.name, email: match.email },
      to,
      subject,
      body,
      inReplyTo,
      references,
    });
    return NextResponse.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error sending email.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
