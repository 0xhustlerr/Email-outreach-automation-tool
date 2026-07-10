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

function pickSender(itemFrom: string): string {
  if (itemFrom.trim()) return itemFrom.trim();
  const ids = listIdentities();
  if (ids.length === 0) return "";
  if (!getSettings().rotateSenders) return ids[0].email;
  const email = ids[state.rotateIndex % ids.length].email;
  state.rotateIndex = (state.rotateIndex + 1) % ids.length;
  return email;
}

// How many accounts are actually sending: the configured pool, or all
// configured identities when no pool is set.
function activeSenderCount(s: QueueSettings): number {
  const configured = new Set(listIdentities().map((i) => i.email.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  return Math.max(1, pool.length || configured.size);
}

// The daily cap is PER GMAIL SENDER; the overall ceiling for the day is that
// per-sender cap times the number of active accounts. (When no per-sender cap
// is set, fall back to the legacy total dailyCap.)
function effectiveDailyCap(s: QueueSettings): number {
  return s.perSenderCap > 0 ? s.perSenderCap * activeSenderCount(s) : s.dailyCap;
}

// Cheap gate used before claiming an opener:
//   "none"   -> no sender pool configured (use the item's own sender)
//   "capped" -> a pool exists but every account hit its daily cap (wait)
//   "ok"     -> at least one pooled account is free
function pooledEligibility(s: QueueSettings): "none" | "capped" | "ok" {
  const configured = new Set(listIdentities().map((i) => i.email.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  if (pool.length === 0) return "none";
  const load = sentTodayBySender();
  const cap = s.perSenderCap > 0 ? s.perSenderCap : Infinity;
  return pool.some((e) => (load[e] ?? 0) < cap) ? "ok" : "capped";
}

// Under-cap pool accounts, optionally excluding one address.
function eligiblePoolSenders(
  s: QueueSettings,
  avoidEmail = "",
  load = sentTodayBySender(),
): string[] {
  const configured = new Set(listIdentities().map((i) => i.email.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  const cap = s.perSenderCap > 0 ? s.perSenderCap : Infinity;
  const avoid = avoidEmail.trim().toLowerCase();
  return pool.filter((e) => (load[e] ?? 0) < cap && e !== avoid);
}

// Is there a free account DIFFERENT from `avoidEmail`? Pure check (no side
// effects) used as claim eligibility so we never even claim an opener we'd
// have to reuse the original sender for.
function hasDifferentFreeSender(
  s: QueueSettings,
  avoidEmail: string,
  load: Record<string, number>,
): boolean {
  return eligiblePoolSenders(s, avoidEmail, load).length > 0;
}

// Choose which account an OPENER goes out from. HARD RULE: never reuse
// `avoidEmail` (the account that already emailed this contact) — returns null
// if the only free account is that one, so the caller holds the send until a
// different account has budget. Among the different free accounts, ALTERNATE
// away from the last account used (no back-to-back).
function pickPooledSender(s: QueueSettings, avoidEmail = ""): string | null {
  const candidates = eligiblePoolSenders(s, avoidEmail);
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
async function sendFollowup(fu: Sequence): Promise<void> {
  const sender = pickSender(fu.fromEmail);
  const result = await performSend({
    to: fu.toEmail,
    subject: replySubject(fu.opSubject),
    body: fu.fuBody,
    fromEmail: sender,
    name: fu.name,
    link: fu.link,
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
  } else {
    markFollowupFailed(fu.id, result.error, MAX_ATTEMPTS);
    state.lastError = result.error;
    console.warn(`[queue] follow-up failed → ${fu.toEmail}: ${result.error}`);
  }
}

// Send a one-time link-free bump to a non-replier as a threaded reply. The
// sequence stays 'scheduled' (bump_sent_at already stamped by claimDueBump), so
// a later reply still triggers the pitch.
async function sendBump(seq: Sequence): Promise<void> {
  const body = nextBumpBody(seq.name);
  if (!body) return; // no bump templates configured
  const sender = pickSender(seq.fromEmail);
  const result = await performSend({
    to: seq.toEmail,
    subject: replySubject(seq.opSubject),
    body,
    fromEmail: sender,
    name: seq.name,
    link: seq.link,
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
  } else {
    state.lastError = result.error;
    console.warn(`[queue] bump failed → ${seq.toEmail}: ${result.error}`);
  }
}

async function loop(): Promise<void> {
  const reset = resetStuckSequences();
  if (reset > 0) console.log(`[queue] recovered ${reset} interrupted step(s)`);

  for (;;) {
    if (state.gen !== MY_GEN) return;
    try {
      const s = getSettings();
      const sinceLast = Date.now() - state.lastSendMs;

      // 0) HOT follow-ups: the opener already got a reply → send the pitch fast
      // (a small spacing only, bypassing the normal drip interval) while the
      // lead is warm. Not gated by the recipient's local window — they just
      // replied, so they're online now.
      if (state.lastSendMs === 0 || sinceLast >= HOT_MIN_GAP_MS) {
        const hot = claimRepliedFollowup(3);
        if (hot) {
          await sendFollowup(hot);
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
      if (s.bumpEnabled) {
        const bump = claimDueBump(s.bumpAfterDays, (seq) => localEligible(seq, s));
        if (bump) {
          await sendBump(bump);
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
      // If a pool is set and every account hit its cap, wait (don't strand a claim).
      const elig = pooledEligibility(s);
      if (elig === "capped") {
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
        if (elig !== "ok") return true; // no pool → item's own sender
        return hasDifferentFreeSender(s, lastSenderForContact(seq.toEmail), load);
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
        const picked = pickPooledSender(s, lastSenderForContact(op.toEmail));
        if (!picked) {
          revertOpenerToPending(op.id);
          await sleep(TICK_MS);
          continue;
        }
        sender = picked;
      } else {
        sender = pickSender(op.fromEmail);
      }
      const result = await performSend({
        to: op.toEmail,
        subject: op.opSubject,
        body: op.opBody,
        fromEmail: sender,
        name: op.name,
        link: op.link,
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
  const perCap = s.perSenderCap > 0 ? s.perSenderCap : Infinity;
  const freeAccounts = pool.filter((e) => (load[e] ?? 0) < perCap);
  const waitingForSender =
    pool.length > 0 && freeAccounts.length === 1
      ? pendingOpenersLastSentBy(freeAccounts[0])
      : 0;
  return {
    enabled: s.enabled,
    withinWindow: withinWindow(s),
    sentToday,
    dailyCap: totalCap, // overall ceiling = per-sender cap × active accounts
    capReached: sentToday >= totalCap,
    nextInSec,
    startAt: s.startAt,
    lastError: state.lastError,
    lastSentAt: state.lastSentAt,
    perSenderCap: s.perSenderCap,
    senderPool: s.senderPool,
    waitingForSender,
    // Distinct contacts each pooled account has sent today (for the UI meters).
    sentBySender: s.senderPool.reduce<Record<string, number>>((acc, e) => {
      acc[e] = load[e] ?? 0;
      return acc;
    }, {}),
  };
}

startQueueWorker();
