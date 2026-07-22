// Shared send-and-log core used by BOTH the immediate /api/send route and the
// background queue worker, so a queued send is logged identically to a manual
// one (send_log + Google Sheet).

import { listIdentities, sendMail } from "./mail";
import { deriveSite, logSendToSheet } from "./sheets";
import { logSendToDb } from "./db";
import { isTrackingEnabled, newTrackToken, pixelUrl } from "./tracking";

export type SendContext = {
  to: string;
  /** Optional second recipient. Silently dropped when invalid or equal to `to`
   *  — a bad CC must never cost us the send to the primary address. */
  cc?: string;
  subject: string;
  body: string;
  fromEmail: string;
  fromName?: string;
  name?: string;
  link?: string;
  linkLinkedin?: string;
  linkGithub?: string;
  username?: string;
  country?: string;
  /** RFC Message-ID of the message being replied to (threads the follow-up). */
  inReplyTo?: string;
  references?: string;
};

export type SendResult =
  | { ok: true; messageId: string; sender: string }
  | { ok: false; error: string; status: number };

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Send one email and log it. Never throws — returns a typed result. */
export async function performSend(ctx: SendContext): Promise<SendResult> {
  const to = ctx.to.trim();
  const subject = ctx.subject.trim();
  const body = ctx.body ?? "";
  const fromEmail = ctx.fromEmail.trim();

  if (!to || !isValidEmail(to)) {
    return { ok: false, error: "Recipient email is invalid.", status: 400 };
  }
  if (!subject) return { ok: false, error: "Subject is required.", status: 400 };
  if (!body.trim()) return { ok: false, error: "Body is required.", status: 400 };
  if (!fromEmail || !isValidEmail(fromEmail)) {
    return { ok: false, error: "Sender email is invalid.", status: 400 };
  }

  // Only configured identities may be used as From — prevents the app from
  // becoming an open relay.
  const match = listIdentities().find(
    (i) => i.email.toLowerCase() === fromEmail.toLowerCase(),
  );
  if (!match) {
    return {
      ok: false,
      error: "Sender email is not in MAIL_IDENTITIES.",
      status: 400,
    };
  }

  // Open tracking: mint a per-send token and embed its pixel (only when a
  // tracking URL is configured). The token is stored on the send_log row so a
  // later opens-poll can mark it opened.
  const trackToken = isTrackingEnabled() ? newTrackToken() : "";
  const trackPixelUrl = trackToken ? pixelUrl(trackToken) ?? undefined : undefined;

  const ccRaw = (ctx.cc ?? "").trim();
  const cc =
    ccRaw && isValidEmail(ccRaw) && ccRaw.toLowerCase() !== to.toLowerCase()
      ? ccRaw
      : undefined;

  try {
    const info = await sendMail({
      from: { name: (ctx.fromName ?? "").trim() || match.name, email: match.email },
      to,
      cc,
      subject,
      body,
      inReplyTo: ctx.inReplyTo,
      references: ctx.references,
      trackPixelUrl,
    });

    const link = (ctx.link ?? "").trim();
    const linkLinkedin = (ctx.linkLinkedin ?? "").trim();
    const linkGithub = (ctx.linkGithub ?? "").trim();
    const logEntry = {
      date: new Date().toISOString(),
      name: (ctx.name ?? "").trim(),
      username: (ctx.username ?? "").trim(),
      country: (ctx.country ?? "").trim(),
      // Site falls back to the LinkedIn/GitHub URL so it isn't blank when the
      // main link field was left empty.
      site: deriveSite(link || linkLinkedin || linkGithub),
      contact: to,
      link,
      sender: match.email,
      mailSent: true,
      trackToken,
    };
    // The DB insert binds named parameters, so it only gets the columns it
    // stores; the extra profile links go to the sheet only.
    logSendToDb(logEntry);
    void logSendToSheet({ ...logEntry, linkLinkedin, linkGithub });

    return { ok: true, messageId: info.messageId, sender: match.email };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error sending email.";
    return { ok: false, error: message, status: 500 };
  }
}
