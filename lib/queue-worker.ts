// Background send engine for two-step sequences.
//
// Two jobs, at most one email per interval (± jitter) so the total send rate
// stays safe:
//   1. Fire DUE follow-ups (both lanes) — threaded replies to openers already
//      sent. These run regardless of the queue enabled flag / window, since
//      they're commitments made when the opener went out. Not capped (the
//      client was already counted when the opener sent).
//   2. Drip QUEUE-lane openers — only while enabled, inside the window, under
//      the daily cap (by distinct address), spaced by the interval.
//
// Started from instrumentation.ts; survives with the tray-kept server.

import { listIdentities } from "./mail";
import { performSend } from "./send-core";
import { recordSendEvent } from "./recent-sends";
import { withinLocalWindow } from "./country";
import { getSettings, type QueueSettings } from "./queue-store";
import { listTemplates } from "./templates-store";
import {
  blockedSenderSet,
  listActiveBlocks,
  type SenderBlock,
} from "./sender-blocks";
import {
  claimDueBump,
  claimNextQueuedOpener,
  claimRepliedFollowup,
  distinctClientsToday,
  lastSenderForContact,
  markFollowupFailed,
  markFollowupSent,
  markOpenerFailed,
  markOpenerSent,
  pendingOpenersLastSentBy,
  resetStuckSequences,
  revertBump,
  revertFollowupToScheduled,
  revertOpenerToPending,
  sentTodayBySender,
  type Sequence,
} from "./sequences-store";

const TICK_MS = 10_000;
const MAX_ATTEMPTS = 3;
// Minimum gap before a reply-triggered ("hot") follow-up fires. It bypasses the
// normal drip interval so warm leads get the pitch within a few minutes, but we
// still keep a small spacing so replies never cause a true back-to-back burst.
const HOT_MIN_GAP_MS = 30_000;

type WorkerState = {
  started: boolean;
  gen: number;
  lastSendMs: number;
  rotateIndex: number;
  bumpIndex: number; // rotates the bump templates
  lastSender: string; // last account any email actually went out from
  lastError: string;
  lastSentAt: string | null;
};

const globalForWorker = globalThis as unknown as { __queueWorker?: WorkerState };
const state: WorkerState = globalForWorker.__queueWorker ?? {
  started: false,
  gen: 0,
  lastSendMs: 0,
  rotateIndex: 0,
  bumpIndex: 0,
  lastSender: "",
  lastError: "",
  lastSentAt: null,
};
globalForWorker.__queueWorker = state;

state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
state.bumpIndex = Number.isFinite(state.bumpIndex) ? state.bumpIndex : 0;
state.started = false;
const MY_GEN = state.gen;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map((n) => parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function withinWindow(s: QueueSettings): boolean {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseHm(s.windowStart);
  const end = parseHm(s.windowEnd);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function nextGapMs(s: QueueSettings): number {
  const jitter = s.jitterSec > 0 ? (Math.random() * 2 - 1) * s.jitterSec : 0;
  return Math.max(5, s.intervalSec + jitter) * 1000;
}

// Non-pooled sender choice, also used by the follow-up and bump lanes (which
// reuse the opener's account verbatim). Returns "" when nothing may send —
// every caller must treat that as "hold this item", not as a send with no From.
function pickSender(itemFrom: string, blocked = blockedSenderSet()): string {
  const pinned = itemFrom.trim();
  if (pinned) return blocked.has(pinned.toLowerCase()) ? "" : pinned;
  const ids = listIdentities().filter(
    (i) => !blocked.has(i.email.toLowerCase()),
  );
  if (ids.length === 0) return "";
  if (!getSettings().rotateSenders) return ids[0].email;
  const email = ids[state.rotateIndex % ids.length].email;
  state.rotateIndex = (state.rotateIndex + 1) % ids.length;
  return email;
}

// Can this sequence's step go out right now, given the blocked accounts?
// from_email is written lowercased by markOpenerSent but VERBATIM by
// recordSentSequence, so normalize before comparing. Legacy rows can still
// carry '' — those fall through to pickSender(""), which rotates, so they're
// eligible exactly when some account is free.
function senderAllowed(
  seq: Sequence,
  blocked: Set<string>,
  anyFree: boolean,
): boolean {
  const from = seq.fromEmail.trim().toLowerCase();
  return from ? !blocked.has(from) : anyFree;
}

// An account's own daily cap from senderCaps; no entry = unlimited.
// Different accounts have different warm-up status, so each carries its
// own limit. (The legacy global per_sender_cap column is ignored.)
function capFor(s: QueueSettings, email: string): number {
  const own = s.senderCaps[email];
  return own && own > 0 ? own : Infinity;
}

// The accounts actually sending: the configured pool, or all configured
// identities when no pool is set. Always lowercased + deduped.
//
// DELIBERATELY NOT blocked-aware, and neither is effectiveDailyCap below.
// distinctClientsToday() counts contacts across ALL senders, so dropping a
// blocked account here would shrink the day's ceiling below a count that still
// includes what that account already sent — e.g. two accounts capped 40, A
// sends 35 and B sends 20, A gets blocked, ceiling falls to 40 while sentToday
// is 55, and the cap gate halts the loop before it ever reaches the pool logic,
// freezing the HEALTHY account for the rest of the day. Blocks and caps are
// orthogonal: caps live here, blocks live in eligiblePoolSenders.
// (QueueModal mirrors this formula client-side, so it must not drift either.)
function activeSenderEmails(s: QueueSettings): string[] {
  const configured = [
    ...new Set(listIdentities().map((i) => i.email.toLowerCase())),
  ];
  const pool = s.senderPool.filter((e) => configured.includes(e));
  return pool.length > 0 ? pool : configured;
}

function activeSenderCount(s: QueueSettings): number {
  return Math.max(1, activeSenderEmails(s).length);
}

// The daily cap is PER GMAIL SENDER; the overall ceiling for the day is the
// sum of each active account's own cap. When any account is uncapped the sum
// is meaningless, so fall back to the legacy total dailyCap.
function effectiveDailyCap(s: QueueSettings): number {
  const caps = activeSenderEmails(s).map((e) => capFor(s, e));
  if (caps.length === 0 || !caps.every(Number.isFinite)) return s.dailyCap;
  return caps.reduce((a, b) => a + b, 0);
}

// Cheap gate used before claiming an opener:
//   "none"   -> no sender pool configured (use the item's own sender)
//   "capped" -> a pool exists but every account hit its daily cap (wait)
//   "ok"     -> at least one pooled account is free
// ("capped" also covers "every pooled account is policy-blocked today" — the
// loop's response is the same: wait, don't strand a claim.)
function pooledEligibility(
  s: QueueSettings,
  blocked = blockedSenderSet(),
): "none" | "capped" | "ok" {
  const configured = new Set(listIdentities().map((i) => i.email.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  if (pool.length === 0) return "none";
  const load = sentTodayBySender();
  return pool.some((e) => (load[e] ?? 0) < capFor(s, e) && !blocked.has(e))
    ? "ok"
    : "capped";
}

// Under-cap, non-blocked pool accounts, optionally excluding one address.
// THE choke point for blocked senders: pickPooledSender and
// hasDifferentFreeSender both route through here, so this one filter covers the
// whole opener path.
function eligiblePoolSenders(
  s: QueueSettings,
  avoidEmail = "",
  load = sentTodayBySender(),
  blocked = blockedSenderSet(),
): string[] {
  const configured = new Set(listIdentities().map((i) => i.email.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  const avoid = avoidEmail.trim().toLowerCase();
  return pool.filter(
    (e) => (load[e] ?? 0) < capFor(s, e) && e !== avoid && !blocked.has(e),
  );
}

// Is there a free account DIFFERENT from `avoidEmail`? Pure check (no side
// effects) used as claim eligibility so we never even claim an opener we'd
// have to reuse the original sender for.
function hasDifferentFreeSender(
  s: QueueSettings,
  avoidEmail: string,
  load: Record<string, number>,
  blocked = blockedSenderSet(),
): boolean {
  return eligiblePoolSenders(s, avoidEmail, load, blocked).length > 0;
}

// Choose which account an OPENER goes out from. HARD RULE: never reuse
// `avoidEmail` (the account that already emailed this contact) — returns null
// if the only free account is that one, so the caller holds the send until a
// different account has budget. Among the different free accounts, ALTERNATE
// away from the last account used (no back-to-back).
function pickPooledSender(
  s: QueueSettings,
  avoidEmail = "",
  blocked = blockedSenderSet(),
): string | null {
  const candidates = eligiblePoolSenders(s, avoidEmail, sentTodayBySender(), blocked);
  if (candidates.length === 0) return null; // no DIFFERENT free account → wait
  if (candidates.length === 1) return candidates[0];

  const others = candidates.filter((e) => e !== state.lastSender);
  const pickFrom = others.length > 0 ? others : candidates;
  const chosen = pickFrom[state.rotateIndex % pickFrom.length];
  state.rotateIndex = (state.rotateIndex + 1) % Math.max(1, pickFrom.length);
  return chosen;
}

// Next bump template body (rotating across the whole library), {{name}}
// substituted. Returns null when there are no bump templates.
function nextBumpBody(name: string): string | null {
  const bumps = listTemplates("bump");
  if (bumps.length === 0) return null;
  const t = bumps[state.bumpIndex % bumps.length];
  state.bumpIndex = (state.bumpIndex + 1) % bumps.length;
  const who = (name || "").trim() || "there";
  return t.body.replace(/\{\{\s*name\s*\}\}/gi, who);
}

function replySubject(openerSubject: string): string {
  const s = openerSubject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// When local-time sending is on, a contact is only eligible if it's currently
// inside their local window. Contacts with an unknown timezone fall through
// (withinLocalWindow returns true) and are governed by the global window.
function localEligible(seq: Sequence, s: QueueSettings): boolean {
  if (!s.localTimeSend) return true;
  return withinLocalWindow(
    seq.timezone,
    parseHm(s.localStart),
    parseHm(s.localEnd),
  );
}

// Send one sequence's follow-up as a threaded reply to its opener, then record
// the outcome. Shared by the hot (reply-triggered) and normal follow-up paths.
// Returns whether a send was attempted; see sendBump for why the caller must
// sleep when it wasn't.
async function sendFollowup(fu: Sequence): Promise<boolean> {
  const sender = pickSender(fu.fromEmail);
  if (!sender) {
    // The account went into a block between the claim and here. Put the step
    // back untouched — it fires tomorrow rather than burning an attempt.
    revertFollowupToScheduled(fu.id);
    return false;
  }
  const result = await performSend({
    to: fu.toEmail,
    // Keep the same Cc as the opener so the thread stays consistent.
    cc: fu.ccEmail,
    subject: replySubject(fu.opSubject),
    body: fu.fuBody,
    fromEmail: sender,
    name: fu.name,
    link: fu.link,
    linkLinkedin: fu.linkLinkedin,
    linkGithub: fu.linkGithub,
    username: fu.username,
    country: fu.country,
    inReplyTo: fu.opMessageId,
    references: fu.opMessageId,
  });
  state.lastSendMs = Date.now();
  // Count this account as "just used" so the next opener alternates away.
  if (sender) state.lastSender = sender.toLowerCase();
  if (result.ok) {
    markFollowupSent(fu.id, result.messageId);
    recordSendEvent(fu.toEmail, "followup", result.sender);
    state.lastError = "";
    state.lastSentAt = new Date().toISOString();
    console.log(`[queue] follow-up sent → ${fu.toEmail}`);
  } else if (result.blockKind === "policy") {
    // The ACCOUNT is blocked, not this contact — reschedule instead of
    // counting a strike toward the permanent 'failed' state.
    revertFollowupToScheduled(fu.id);
    state.lastError = result.error;
    console.warn(`[queue] follow-up held (sender blocked) → ${fu.toEmail}`);
  } else {
    markFollowupFailed(fu.id, result.error, MAX_ATTEMPTS);
    state.lastError = result.error;
    console.warn(`[queue] follow-up failed → ${fu.toEmail}: ${result.error}`);
  }
  return true;
}

// Send a one-time link-free bump to a non-replier as a threaded reply. The
// sequence stays 'scheduled' (bump_sent_at already stamped by claimDueBump), so
// a later reply still triggers the pitch.
//
// Returns whether a send was actually ATTEMPTED. The caller must sleep when it
// wasn't: the bump lane `continue`s, and the paths below that bail early leave
// state.lastSendMs untouched, so without a sleep the loop would re-claim and
// spin with no timer in it.
async function sendBump(seq: Sequence): Promise<boolean> {
  const body = nextBumpBody(seq.name);
  if (!body) {
    revertBump(seq.id); // no bump templates — don't consume the one chance
    return false;
  }
  const sender = pickSender(seq.fromEmail);
  if (!sender) {
    revertBump(seq.id);
    return false;
  }
  const result = await performSend({
    to: seq.toEmail,
    cc: seq.ccEmail,
    subject: replySubject(seq.opSubject),
    body,
    fromEmail: sender,
    name: seq.name,
    link: seq.link,
    linkLinkedin: seq.linkLinkedin,
    linkGithub: seq.linkGithub,
    username: seq.username,
    country: seq.country,
    inReplyTo: seq.opMessageId,
    references: seq.opMessageId,
  });
  state.lastSendMs = Date.now();
  if (sender) state.lastSender = sender.toLowerCase();
  if (result.ok) {
    recordSendEvent(seq.toEmail, "followup", result.sender);
    state.lastError = "";
    state.lastSentAt = new Date().toISOString();
    console.log(`[queue] bump sent → ${seq.toEmail}`);
  } else if (result.blockKind === "policy") {
    // Only un-stamp for an ACCOUNT-level block, which will clear by itself.
    // Reverting on every failure would be wrong: a bump has no attempt counter,
    // so a permanently-failing one (dead address) would be re-claimed forever
    // and — because this lane runs before the openers and `continue`s — would
    // consume every drip slot and stall the queue indefinitely.
    revertBump(seq.id);
    state.lastError = result.error;
    console.warn(`[queue] bump held (sender blocked) → ${seq.toEmail}`);
  } else {
    state.lastError = result.error;
    console.warn(`[queue] bump failed → ${seq.toEmail}: ${result.error}`);
  }
  return true;
}

async function loop(): Promise<void> {
  const reset = resetStuckSequences();
  if (reset > 0) console.log(`[queue] recovered ${reset} interrupted step(s)`);

  for (;;) {
    if (state.gen !== MY_GEN) return;
    try {
      const s = getSettings();
      const sinceLast = Date.now() - state.lastSendMs;
      // One snapshot per tick, threaded into every sender decision below so a
      // single claim scan can't issue 200 queries.
      const blocked = blockedSenderSet();
      const anyFree = listIdentities().some(
        (i) => !blocked.has(i.email.toLowerCase()),
      );

      // 0) HOT follow-ups: the opener already got a reply → send the pitch fast
      // (a small spacing only, bypassing the normal drip interval) while the
      // lead is warm. Not gated by the recipient's local window — they just
      // replied, so they're online now.
      if ((state.lastSendMs === 0 || sinceLast >= HOT_MIN_GAP_MS) && anyFree) {
        // Pass the eligibility filter ONLY when something is actually blocked:
        // with no predicate the claim runs LIMIT 1, with one it scans 200 rows
        // through a correlated EXISTS subquery. Keep the common path identical.
        const hot = claimRepliedFollowup(
          3,
          blocked.size > 0
            ? (seq) => senderAllowed(seq, blocked, anyFree)
            : undefined,
        );
        if (hot) {
          if (!(await sendFollowup(hot))) await sleep(TICK_MS);
          continue;
        }
      }

      // Respect send spacing for the normal drip (one email per interval).
      const gap = nextGapMs(s);
      if (state.lastSendMs > 0 && sinceLast < gap) {
        await sleep(Math.min(gap - sinceLast, TICK_MS));
        continue;
      }

      // 1) Bump non-repliers: one short LINK-FREE nudge N days after the opener.
      // (The pitch itself is reply-only — handled by the hot path above.) The
      // sequence stays 'scheduled', so a later reply still fires the pitch.
      // The template check is BEFORE the claim on purpose: with no bump
      // templates, claiming would only be undone again on the next line, and
      // the lane would churn a claim/revert pair every tick forever.
      if (s.bumpEnabled && anyFree && listTemplates("bump").length > 0) {
        // Gate in the PREDICATE, never after the claim: claimDueBump stamps
        // bump_sent_at as it claims and only ever claims rows where that is
        // NULL, so an early return here would lose the bump forever.
        const bump = claimDueBump(
          s.bumpAfterDays,
          (seq) => localEligible(seq, s) && senderAllowed(seq, blocked, anyFree),
        );
        if (bump) {
          if (!(await sendBump(bump))) await sleep(TICK_MS);
          continue;
        }
      }

      // 2) Queue-lane openers. Gated by enabled + total cap. The window check is
      // the global window in normal mode, or the PER-RECIPIENT window in
      // local-time mode (so the drip runs across all hours per contact).
      const globalWindowOk = s.localTimeSend || withinWindow(s);
      if (
        !s.enabled ||
        !globalWindowOk ||
        distinctClientsToday() >= effectiveDailyCap(s)
      ) {
        await sleep(TICK_MS);
        continue;
      }
      // If a pool is set and every account hit its cap (or is blocked), wait
      // (don't strand a claim).
      const elig = pooledEligibility(s, blocked);
      if (elig === "capped") {
        await sleep(TICK_MS);
        continue;
      }
      // No pool + every configured account blocked: nothing can send. Bail
      // before claiming, otherwise we'd claim and revert an opener every tick.
      if (elig === "none" && !anyFree) {
        await sleep(TICK_MS);
        continue;
      }
      // HARD RULE: a re-send must NOT reuse the account that already emailed the
      // contact. Fold that into claim eligibility so we SKIP (don't claim) any
      // opener whose only free account is its original sender — it waits until a
      // different account has budget (or tomorrow) instead of reusing the same.
      const load = elig === "ok" ? sentTodayBySender() : {};
      const op = claimNextQueuedOpener((seq) => {
        if (!localEligible(seq, s)) return false;
        // No pool → the item's own sender is used verbatim, so it must be free.
        if (elig !== "ok") return senderAllowed(seq, blocked, anyFree);
        return hasDifferentFreeSender(
          s,
          lastSenderForContact(seq.toEmail),
          load,
          blocked,
        );
      });
      if (!op) {
        await sleep(TICK_MS);
        continue;
      }
      // Pool active → a FREE account different from the one that already emailed
      // this contact is guaranteed by the eligibility check above. If somehow
      // gone (race), put the opener back rather than reuse the original sender.
      let sender: string;
      if (elig === "ok") {
        const picked = pickPooledSender(
          s,
          lastSenderForContact(op.toEmail),
          blocked,
        );
        if (!picked) {
          revertOpenerToPending(op.id);
          await sleep(TICK_MS);
          continue;
        }
        sender = picked;
      } else {
        sender = pickSender(op.fromEmail, blocked);
        if (!sender) {
          revertOpenerToPending(op.id);
          await sleep(TICK_MS);
          continue;
        }
      }
      const result = await performSend({
        to: op.toEmail,
        cc: op.ccEmail,
        subject: op.opSubject,
        body: op.opBody,
        fromEmail: sender,
        name: op.name,
        link: op.link,
        linkLinkedin: op.linkLinkedin,
        linkGithub: op.linkGithub,
        username: op.username,
        country: op.country,
      });
      state.lastSendMs = Date.now();
      if (sender) state.lastSender = sender.toLowerCase();
      if (result.ok) {
        markOpenerSent(op.id, result.messageId, result.sender);
        recordSendEvent(op.toEmail, "opener", result.sender);
        state.lastError = "";
        state.lastSentAt = new Date().toISOString();
        console.log(`[queue] opener sent → ${op.toEmail} (as ${result.sender})`);
      } else if (result.blockKind === "policy") {
        // Gmail blocked the ACCOUNT, not this contact. Put the opener back
        // untouched. Without this, markOpenerFailed would count a strike and —
        // since claims are ORDER BY id ASC — the same head-of-queue contact
        // gets re-claimed and permanently killed after three tries, then the
        // next one, for as long as the block lasts.
        revertOpenerToPending(op.id);
        state.lastError = result.error;
        console.warn(`[queue] opener held (sender blocked) → ${op.toEmail}`);
      } else {
        markOpenerFailed(op.id, result.error, MAX_ATTEMPTS);
        state.lastError = result.error;
        console.warn(`[queue] opener failed → ${op.toEmail}: ${result.error}`);
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      await sleep(TICK_MS);
    }
  }
}

export function startQueueWorker(): void {
  if (state.started) return;
  state.started = true;
  console.log("[queue] two-step engine armed");
  void loop();
}

export function queueWorkerStatus() {
  const s = getSettings();
  const sentToday = distinctClientsToday();
  const gap = Math.max(5, s.intervalSec) * 1000;
  const since = Date.now() - state.lastSendMs;
  const nextInSec =
    state.lastSendMs > 0 && since < gap ? Math.ceil((gap - since) / 1000) : 0;
  const load = sentTodayBySender();
  const totalCap = effectiveDailyCap(s);
  // Openers held back by the hard "different sender" rule: only possible when
  // exactly ONE pool account is free — then contacts whose original sender is
  // that account have no different account and must wait. With 3+ accounts this
  // is almost always 0.
  const configured = new Set(listIdentities().map((i) => i.email.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  const blockedSenders: SenderBlock[] = listActiveBlocks();
  const blockedSet = new Set(blockedSenders.map((b) => b.sender));
  // "Free" must mean actually usable, or this under-reports next to the new
  // blocked counter in the same stat strip.
  const freeAccounts = pool.filter(
    (e) => (load[e] ?? 0) < capFor(s, e) && !blockedSet.has(e),
  );
  const waitingForSender =
    pool.length > 0 && freeAccounts.length === 1
      ? pendingOpenersLastSentBy(freeAccounts[0])
      : 0;
  // Every eligible account blocked → the drip can't send at all. Lets the UI
  // say so instead of showing a silent idle with a ticking countdown.
  const activeEmails = activeSenderEmails(s);
  const allSendersBlocked =
    activeEmails.length > 0 && activeEmails.every((e) => blockedSet.has(e));
  return {
    blockedSenders,
    allSendersBlocked,
    enabled: s.enabled,
    withinWindow: withinWindow(s),
    sentToday,
    dailyCap: totalCap, // overall ceiling = sum of each active account's cap
    capReached: sentToday >= totalCap,
    nextInSec,
    startAt: s.startAt,
    lastError: state.lastError,
    lastSentAt: state.lastSentAt,
    senderCaps: s.senderCaps,
    senderPool: s.senderPool,
    waitingForSender,
    // Distinct contacts each account has sent today (for the UI meters and
    // the Send modal's cap warning). Covers pool + all configured identities.
    sentBySender: [...new Set([...s.senderPool, ...configured])].reduce<
      Record<string, number>
    >((acc, e) => {
      acc[e] = load[e] ?? 0;
      return acc;
    }, {}),
    // Each account's resolved daily cap (0 = unlimited; JSON can't carry
    // Infinity), so meters/warnings can show per-account limits.
    capBySender: [...new Set([...s.senderPool, ...configured])].reduce<
      Record<string, number>
    >((acc, e) => {
      const c = capFor(s, e);
      acc[e] = Number.isFinite(c) ? c : 0;
      return acc;
    }, {}),
  };
}

startQueueWorker();
