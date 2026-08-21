// Background send engine for two-step sequences.
//
// Three lanes, at most one email per interval (± jitter) so the total send rate
// stays safe. Strict priority — a lane only runs when every lane above it had
// nothing to send:
//   1. Reply-triggered PITCH — a threaded reply to a contact who answered the
//      opener. Runs regardless of the enabled flag, window and daily cap, and
//      bypasses the drip interval (a small spacing aside): it's a commitment
//      made when the opener went out, and the lead is warm right now. Not
//      capped — the client was already counted when the opener sent.
//   2. Drip QUEUE-lane openers — only while enabled, inside the window, under
//      the daily cap (by distinct address), spaced by the interval.
//   3. Link-free BUMP to a non-replier — lowest priority. Gated by everything
//      lane 2 is gated by, AND held until the opener queue is fully drained and
//      no pitch is waiting. A bump has no deadline, so it yields to both.
//
// Started from instrumentation.ts; survives with the tray-kept server.

import { listIdentities, resetSmtpNetworkCaches } from "./mail";
import { performSend } from "./send-core";
import { recordSendEvent } from "./recent-sends";
import { withinLocalWindow } from "./country";
import { getSettings, type QueueSettings } from "./queue-settings-store";
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
  hasPendingOpeners,
  lastSenderForContact,
  markFollowupFailed,
  markFollowupSent,
  markOpenerFailed,
  markOpenerSent,
  pendingOpenersLastSentBy,
  recoverInterruptedSequences,
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
  /** Current offline backoff, 0 when the link is healthy. */
  netBackoffMs: number;
  /** When the current outage started, null when healthy. */
  offlineSince: string | null;
  /** Epoch ms of the next attempt while offline (drives the UI countdown). */
  netRetryAt: number;
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
  netBackoffMs: 0,
  offlineSince: null,
  netRetryAt: 0,
};
globalForWorker.__queueWorker = state;

// NOTE: neither the generation bump nor `started = false` belongs here. Any
// route bundle that imports this file (app/api/queue/route.ts pulls in
// queueWorkerStatus) gets its own copy of the module, and this one SELF-STARTS
// at the bottom — so resetting either at module scope lets that copy retire the
// live loop and arm a replacement, which opens with crash recovery and
// can flip a row the outgoing loop is still mid-performSend on back to
// 'pending', sending it twice. Same fix as the reply-sync and bounce-watch
// loops, which can additionally clear `started` here only because they do not
// self-start. The cost is that a dev edit to THIS file needs a server restart
// rather than an HMR reload to take effect.
state.bumpIndex = Number.isFinite(state.bumpIndex) ? state.bumpIndex : 0;
state.netBackoffMs = Number.isFinite(state.netBackoffMs) ? state.netBackoffMs : 0;
state.netRetryAt = Number.isFinite(state.netRetryAt) ? state.netRetryAt : 0;
state.offlineSince = state.offlineSince ?? null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Offline backoff ---------------------------------------------------------
// A dropped connection is a fault of the LINK, not of the contact being mailed,
// so a transient send failure marks nothing failed and burns no attempt: the
// step goes straight back to its queued state and the whole loop waits. Same
// doubling shape as reply-sync-loop / bounce-watch so every background loop
// behaves alike on a bad connection.
const NET_BACKOFF_MIN_MS = 15_000;
const NET_BACKOFF_MAX_MS = 300_000;
// How far past a missed retry deadline the outage is considered over. Must
// comfortably exceed one send attempt's worst case (SMTP connect + greeting +
// socket timeouts), or a slow-failing retry would look like a cleared outage.
const NET_STALE_MS = 120_000;

/** Record a link failure and return how long the loop should now wait. */
function noteNetworkFailure(error: string): number {
  if (state.netBackoffMs === 0) {
    // First drop of this outage: the DoH-resolved IP (and the transport pinned
    // to it) can be stale by the time we're back, so force a re-resolve rather
    // than retrying a dead address for the length of the DNS TTL.
    resetSmtpNetworkCaches();
    state.offlineSince = new Date().toISOString();
    console.warn(`[queue] connection lost — holding the queue: ${error}`);
  }
  state.netBackoffMs = Math.min(
    NET_BACKOFF_MAX_MS,
    Math.max(NET_BACKOFF_MIN_MS, state.netBackoffMs * 2),
  );
  state.netRetryAt = Date.now() + state.netBackoffMs;
  state.lastError = error;
  return state.netBackoffMs;
}

/** Clear the outage after anything actually gets through. */
function noteNetworkOk(): void {
  if (state.netBackoffMs > 0) console.log("[queue] connection restored");
  state.netBackoffMs = 0;
  state.offlineSince = null;
  state.netRetryAt = 0;
}

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

// What a lane did with the item it claimed, so the loop knows how long to wait:
//   "attempted" — an email actually went down the wire (drip spacing applies)
//   "held"      — nothing was sent, item put back (short tick)
//   "offline"   — the link is down, item put back (offline backoff)
type LaneOutcome = "attempted" | "held" | "offline";

// Send one sequence's follow-up as a threaded reply to its opener, then record
// the outcome. Shared by the hot (reply-triggered) and normal follow-up paths.
// See sendBump for why the caller must sleep when nothing was attempted.
async function sendFollowup(fu: Sequence): Promise<LaneOutcome> {
  const sender = pickSender(fu.fromEmail);
  if (!sender) {
    // The account went into a block between the claim and here. Put the step
    // back untouched — it fires tomorrow rather than burning an attempt.
    revertFollowupToScheduled(fu.id);
    return "held";
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
  if (!result.ok && result.transient) {
    // Nothing left the machine, so don't spend a drip slot on it and don't
    // count a strike — put the step back and let the loop wait out the outage.
    revertFollowupToScheduled(fu.id);
    console.warn(`[queue] follow-up held (offline) → ${fu.toEmail}`);
    noteNetworkFailure(result.error);
    return "offline";
  }
  // Non-transient means we reached Gmail and it answered — whatever it said,
  // the link is up.
  noteNetworkOk();
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
  return "attempted";
}

// Send a one-time link-free bump to a non-replier as a threaded reply. The
// sequence stays 'scheduled' (bump_sent_at already stamped by claimDueBump), so
// a later reply still triggers the pitch.
//
// The caller must sleep whenever nothing was attempted: the bump lane
// `continue`s, and the paths below that bail early leave state.lastSendMs
// untouched, so without a sleep the loop would re-claim and spin with no timer
// in it.
async function sendBump(seq: Sequence): Promise<LaneOutcome> {
  const body = nextBumpBody(seq.name);
  if (!body) {
    revertBump(seq.id); // no bump templates — don't consume the one chance
    return "held";
  }
  const sender = pickSender(seq.fromEmail);
  if (!sender) {
    revertBump(seq.id);
    return "held";
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
  if (!result.ok && result.transient) {
    // Safe to un-stamp for the same reason as a policy block, and necessary:
    // a bump has no attempt counter, so every bump attempted during an outage
    // was previously lost forever. The spin risk the comment below warns about
    // doesn't apply — an offline revert is followed by the offline backoff, not
    // by an immediate re-claim.
    revertBump(seq.id);
    console.warn(`[queue] bump held (offline) → ${seq.toEmail}`);
    noteNetworkFailure(result.error);
    return "offline";
  }
  noteNetworkOk(); // reached Gmail — see sendFollowup
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
    // so a permanently-failing one (dead address) would be re-claimed every
    // interval forever — re-mailing a bad address and, since claims are ORDER BY
    // op_sent_at ASC, starving every other bump queued behind it.
    revertBump(seq.id);
    state.lastError = result.error;
    console.warn(`[queue] bump held (sender blocked) → ${seq.toEmail}`);
  } else {
    state.lastError = result.error;
    console.warn(`[queue] bump failed → ${seq.toEmail}: ${result.error}`);
  }
  return "attempted";
}

async function loop(myGen: number): Promise<void> {
  // Guarded because it runs OUTSIDE the per-tick try below: a throw here (a
  // locked DB on a cold boot, say) would kill the engine before it ever
  // reached the loop, and nothing would send until the app was restarted.
  try {
    const reset = recoverInterruptedSequences();
    if (reset.requeued > 0 || reset.delivered > 0) {
      console.log(
        `[queue] recovered ${reset.requeued} interrupted step(s)` +
          (reset.delivered > 0
            ? `, ${reset.delivered} already delivered (kept sent, not re-queued)`
            : ""),
      );
    }
  } catch (err) {
    console.error("[queue] crash recovery failed, continuing:", err);
  }

  for (;;) {
    if (state.gen !== myGen) return;
    try {
      // Only a successful send clears the outage — but if the queue emptied,
      // was paused, hit its cap or left its window while we were down, no send
      // is coming to clear it and the UI would claim "connection lost" forever.
      // Once the retry deadline has passed with no attempt made, the network is
      // no longer what's holding anything back, so stop reporting it as such.
      if (
        state.netBackoffMs > 0 &&
        Date.now() > state.netRetryAt + NET_STALE_MS
      ) {
        noteNetworkOk();
      }
      const s = getSettings();
      const sinceLast = Date.now() - state.lastSendMs;
      // One snapshot per tick, threaded into every sender decision below so a
      // single claim scan can't issue 200 queries.
      const blocked = blockedSenderSet();
      const anyFree = listIdentities().some(
        (i) => !blocked.has(i.email.toLowerCase()),
      );

      // 1) HOT follow-ups: the opener already got a reply → send the pitch fast
      // (a small spacing only, bypassing the normal drip interval) while the
      // lead is warm. Not gated by the recipient's local window — they just
      // replied, so they're online now.
      //
      // Set when this lane RAN and found nothing: the bump lane needs "no pitch
      // is waiting" and this is the only cheap proof of it. Testing it directly
      // would mean a second EXISTS(send_log …) on every idle tick, and that
      // correlation uses LIKE '%…%' so it can't touch idx_send_log_contact —
      // a full send_log scan every 10s. Note it inherits this lane's own blind
      // spots: a reply the sync loop hasn't recorded yet (up to SYNC_MS) and an
      // opener younger than the 3-minute floor both read as "clear".
      let noPitchWaiting = false;
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
          const outcome = await sendFollowup(hot);
          if (outcome === "offline") await sleep(state.netBackoffMs);
          else if (outcome === "held") await sleep(TICK_MS);
          continue;
        }
        noPitchWaiting = true;
      }

      // Respect send spacing for the normal drip (one email per interval).
      const gap = nextGapMs(s);
      if (state.lastSendMs > 0 && sinceLast < gap) {
        await sleep(Math.min(gap - sinceLast, TICK_MS));
        continue;
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
        // 3) Bump non-repliers: one short LINK-FREE nudge N days after the
        // opener. (The pitch itself is reply-only — lane 1 above.) The sequence
        // stays 'scheduled', so a later reply still fires the pitch.
        //
        // Lowest lane, and it lives INSIDE this branch on purpose. The opener
        // path below has no trailing `continue` — it falls off the bottom of
        // the try — so a bump block placed after it would send an opener and
        // then immediately claim and send a bump on the same tick, bypassing
        // the drip gap entirely. Nesting it here makes that impossible.
        //
        // hasPendingOpeners(), not just `!op`: a null claim only means nothing
        // is sendable THIS INSTANT (all held by local window, sender rules, the
        // different-sender rule). A bump waits for the queue to be genuinely
        // drained, so a still-loaded campaign always outranks it.
        //
        // Sitting below the enabled/window/cap and pool gates is the point —
        // bumps now pause, respect the window, and spend the daily cap like
        // every other send. Two consequences worth knowing: a pooled cap can
        // hold a bump whose own account is free (bumps reuse the opener's
        // sender verbatim for thread continuity), and a queue that never drains
        // starves bumps indefinitely. Nothing is lost when that happens —
        // claimDueBump has no upper age bound, so the bump just fires late, and
        // a reply in the meantime cancels it in favour of the pitch.
        //
        // The template check is BEFORE the claim on purpose: with no bump
        // templates, claiming would only be undone again on the next line, and
        // the lane would churn a claim/revert pair every tick forever.
        if (
          s.bumpEnabled &&
          anyFree &&
          noPitchWaiting &&
          !hasPendingOpeners() &&
          listTemplates("bump").length > 0
        ) {
          // Gate in the PREDICATE, never after the claim: claimDueBump stamps
          // bump_sent_at as it claims and only ever claims rows where that is
          // NULL, so an early return here would lose the bump forever.
          const bump = claimDueBump(
            s.bumpAfterDays,
            (seq) =>
              localEligible(seq, s) && senderAllowed(seq, blocked, anyFree),
          );
          if (bump) {
            const outcome = await sendBump(bump);
            if (outcome === "offline") await sleep(state.netBackoffMs);
            else if (outcome === "held") await sleep(TICK_MS);
            continue;
          }
        }
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
      if (!result.ok && result.transient) {
        // The link is down: nothing reached Gmail, so this contact is blameless.
        // Put the opener back WITHOUT burning an attempt — three connection
        // drops used to mark three prospects permanently failed and cancel
        // their follow-ups — and hold the whole loop until the link returns.
        revertOpenerToPending(op.id);
        console.warn(`[queue] opener held (offline) → ${op.toEmail}`);
        await sleep(noteNetworkFailure(result.error));
        continue;
      }
      noteNetworkOk(); // reached Gmail — see sendFollowup
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
  // Bumped HERE, not at module scope, so only a real start retires the running
  // loop — see the note by the state declaration.
  state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
  const myGen = state.gen;
  console.log("[queue] two-step engine armed");
  // If the loop ever dies outright, release `started` so a later arm can
  // replace it. Since this module no longer clears that flag at import time
  // (see the note by the state declaration), nothing else would.  A normal
  // return means a newer generation took over and already owns the flag.
  void loop(myGen).catch((err) => {
    console.error("[queue] engine stopped unexpectedly:", err);
    state.started = false;
  });
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
  // The link is down and the loop is waiting it out. Surfaced so the UI can say
  // so instead of rendering a next-send countdown that will never fire.
  const offline = state.netBackoffMs > 0;
  return {
    blockedSenders,
    allSendersBlocked,
    offline,
    offlineSince: state.offlineSince,
    retryInSec: offline
      ? Math.max(0, Math.ceil((state.netRetryAt - Date.now()) / 1000))
      : 0,
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
    // The bump lane can't fire without at least one bump template — a
    // worker-side gate the client can't otherwise see, so it would promise a
    // bump that can never send and let a phantom due date drag the "all sent"
    // estimate out forever.
    bumpTemplates: listTemplates("bump").length,
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
