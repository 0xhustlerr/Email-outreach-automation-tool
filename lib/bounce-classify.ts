// Classifies bounce text into "the ACCOUNT is in trouble" vs "that ONE address
// is bad". Pure and dependency-free so it can be unit-tested against saved DSN
// bodies, and so both detectors share one implementation:
//
//   1. the SMTP catch in send-core (a synchronous 550-5.7.x rejection), and
//   2. the DSN scanner in bounce-watch (the async mailer-daemon bounce).
//
// Only a POLICY verdict pauses an account. Invalid-address bounces are the
// normal cost of cold outreach to scraped addresses - treating those as a block
// would burn a sending day on every typo.

export type BounceKind = "policy" | "invalid" | "other";

export type BounceVerdict = {
  kind: BounceKind;
  /** Enhanced SMTP status code ('5.7.1'), or '' when the text carried none. */
  statusCode: string;
  /** The line that decided it - shown in the UI tooltip / stored for audit. */
  detail: string;
};

// Enhanced status codes are machine-generated and authoritative; the prose
// around them is noisy and localized. Codes therefore outrank text below.
//
// 5.7.x  - policy/reputation rejection ("our system has detected...").
// 5.4.5  - daily sending limit exceeded. A quota rather than reputation, but
//          "this account is done for today" is exactly the state we model.
// 4.7.x  - transient "slow down" signals; backing off is the whole point.
const POLICY_CODE_RE = /\b(?:5\.7\.(?:0|1|26|28|29|30)|4\.7\.(?:0|28)|5\.4\.5)\b/;

// 5.1.x / 5.2.x - unknown user, bad mailbox, over quota. Recipient-specific.
const INVALID_CODE_RE = /\b(?:5\.1\.[0136]|5\.2\.[012]|5\.4\.1)\b/;

const POLICY_TEXT_RE = new RegExp(
  [
    "message blocked",
    "message rejected",
    "this message has been blocked",
    "our system has detected",
    "unusual rate",
    "unsolicited (?:mail|messages?)",
    "likely (?:unsolicited|spam)",
    "suspected spam",
    "spam(?:my)? (?:content|message)",
    "blocked for (?:spam|abuse|policy)",
    "reputation",
    "rate limit(?:ed)?",
    "sending (?:rate )?limit",
    "daily (?:user )?sending limit exceeded",
    "policy (?:reasons|violation)",
    "not accepted for policy reasons",
    // Google's own machine-readable error slugs.
    "unsolicitedmessageerror",
    "unsolicitedratelimiterror",
    "unsolicitedipratelimiterror",
    "blockedaccounterror",
    "defaultdomainsendlimit",
    "bulksendthrottle",
    // Help-article ids for the BLOCK articles only - see the warning below.
    "support\\.google\\.com/mail/\\?p=(?:unsolicited|blockedaccount|defaultdomainsendlimit|ipnotinwhitelist|bulksend)",
    "support\\.google\\.com/mail/(?:answer/)?(?:69585|81126|188131)\\b",
  ].join("|"),
  "i",
);

// WARNING: never widen the policy set to a generic `support.google.com/mail/`
// pattern. Gmail's ordinary "Address not found" bounce links answer/6596, so a
// wildcard there would classify every dead scraped address as a reputation
// block and pause the account on a single typo.
const INVALID_TEXT_RE = new RegExp(
  [
    "address not found",
    "recipient(?:'s|s')? email address (?:was not|wasn'?t) found",
    "user unknown",
    "unknown user",
    "no such (?:user|address|recipient|mailbox)",
    "does not exist",
    "doesn'?t exist",
    "mailbox (?:is )?(?:unavailable|not found|does not exist)",
    "recipient address rejected",
    "invalid recipient",
    "mailbox (?:is )?full",
    "over quota",
    "quota exceeded",
    "account (?:has been )?(?:disabled|suspended|deleted)",
    "support\\.google\\.com/mail/(?:answer/)?6596\\b",
  ].join("|"),
  "i",
);

const DSN_FROM_RE = /^(?:mailer-daemon|mailer_daemon|mail-daemon|postmaster)@/i;

const DSN_SUBJECT_RE =
  /(?:delivery status notification|undeliverable|undelivered mail|mail delivery (?:failed|subsystem)|returned mail|delivery incomplete|address not found|message (?:blocked|not delivered)|failure notice)/i;

// Any enhanced status code, for reporting. `-` is a non-word character, so \b
// matches inside Gmail's continuation form ("550-5.7.1") as well as "550 5.7.1".
const ANY_CODE_RE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

// DSN structured fields (RFC 3464), plus Gmail's human phrasing as a fallback.
const FINAL_RECIPIENT_RE = /^(?:final|original)-recipient:\s*rfc822;\s*(.+)$/im;
const YOUR_MESSAGE_TO_RE =
  /your message (?:wasn'?t delivered to |to )([^\s<>]+@[^\s<>,]+)/i;

/** True when this looks like a delivery-status notification rather than a reply. */
export function isDsnMessage(fromEmail: string, subject: string): boolean {
  return DSN_FROM_RE.test(fromEmail.trim()) || DSN_SUBJECT_RE.test(subject);
}

/** The enhanced status code in `text`, or ''. */
export function extractStatusCode(text: string): string {
  return text.match(ANY_CODE_RE)?.[1] ?? "";
}

/** The address that failed, for the audit trail. '' when it can't be read. */
export function extractFailedRecipient(text: string): string {
  const dsn = text.match(FINAL_RECIPIENT_RE)?.[1];
  if (dsn) return dsn.trim().replace(/^<|>$/g, "").toLowerCase();
  const human = text.match(YOUR_MESSAGE_TO_RE)?.[1];
  return human ? human.trim().replace(/^<|>$/g, "").toLowerCase() : "";
}

/** The line containing `match`, trimmed - what the UI shows as the reason. */
function lineAround(text: string, match: string): string {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes(match.toLowerCase()));
  return (line ?? match).trim().slice(0, 300);
}

/**
 * Classify a bounce body or a raw SMTP response.
 *
 * A real DSN often names several failures at once (one bad address in a batch,
 * plus boilerplate), so both sets can match. Codes decide in that case; when
 * only prose matches ambiguously we fall to "invalid", which is the safe way to
 * be wrong: Google always emits a 5.7.x for a genuine policy rejection, so a
 * real block is never missed, while a stray "spam" in quoted text can't cost a
 * sending day.
 */
export function classifyBounceText(text: string): BounceVerdict {
  const body = text ?? "";
  const statusCode = extractStatusCode(body);
  if (!body.trim()) return { kind: "other", statusCode, detail: "" };

  const policyCode = POLICY_CODE_RE.exec(body)?.[0] ?? "";
  const invalidCode = INVALID_CODE_RE.exec(body)?.[0] ?? "";
  const policyText = POLICY_TEXT_RE.exec(body)?.[0] ?? "";
  const invalidText = INVALID_TEXT_RE.exec(body)?.[0] ?? "";

  const policyHit = !!(policyCode || policyText);
  const invalidHit = !!(invalidCode || invalidText);

  if (policyHit && !invalidHit) {
    return {
      kind: "policy",
      statusCode: policyCode || statusCode,
      detail: lineAround(body, policyText || policyCode),
    };
  }
  if (invalidHit && !policyHit) {
    return {
      kind: "invalid",
      statusCode: invalidCode || statusCode,
      detail: lineAround(body, invalidText || invalidCode),
    };
  }
  if (policyHit && invalidHit) {
    if (policyCode) {
      return {
        kind: "policy",
        statusCode: policyCode,
        detail: lineAround(body, policyCode),
      };
    }
    return {
      kind: "invalid",
      statusCode: invalidCode || statusCode,
      detail: lineAround(body, invalidCode || invalidText),
    };
  }
  return { kind: "other", statusCode, detail: "" };
}
