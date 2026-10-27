// Out-of-office and other machine-sent answers are not replies. Reply sync
// marks a contact replied, and a replied contact gets the Pitch within minutes
// (claimRepliedFollowup), so letting a vacation responder count would fire the
// full pitch at someone who is away - and cancel the Bump they were due.

/** Headers fetchInboundMeta asks Gmail for so this check can run. */
export const AUTO_REPLY_HEADERS = [
  "Auto-Submitted",
  "X-Autoreply",
  "X-Autorespond",
  "Precedence",
] as const;

// Outlook/Exchange out-of-office answers are the common case that does not
// always carry Auto-Submitted, but they do always carry this subject prefix.
const AUTO_REPLY_SUBJECT =
  /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office)\b/i;

export function isAutomatedReply(
  header: (name: (typeof AUTO_REPLY_HEADERS)[number]) => string,
  subject: string,
): boolean {
  // RFC 3834: any value other than "no" means a machine sent it.
  const autoSubmitted = header("Auto-Submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (header("X-Autoreply") || header("X-Autorespond")) return true;
  if (/^(auto_reply|bulk|junk|list)$/i.test(header("Precedence"))) return true;
  return AUTO_REPLY_SUBJECT.test(subject);
}
