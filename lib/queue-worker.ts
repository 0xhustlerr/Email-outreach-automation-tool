// Background send engine for two-step sequences — the SHELL around the Send
// plan (lib/send-plan.ts).
//
// Each tick gathers the plan's inputs from the stores (settings, per-lane
// queued items, the blocked-Sender set, identities), runs the pure
// computeSendPlan, and executes the plan's first due action by walking the
// attempt Lanes in strict priority order (Pitch > Opener > Bump) through the
// existing transactional Claims. The plan is advisory; the Claims stay
// authoritative and re-validate eligibility — including reply state, which
// the plan never queries (ADR-0001).
//
// Scheduling knowledge lives in the plan module; this file owns only the
// gathering, the Claims, the wire sends and their outcome bookkeeping, and the
// loop lifecycle. Worker RAM state (sender rotation, bump rotation, last send,
// network backoff) is threaded through the pure decisions as explicit
// input/output — ramState()/applyRam below are the only bridge to the
// module-global singleton the lifecycle needs.
//
// Armed only by instrumentation.ts at server boot (ADR-0002) — importing this
// module never starts the loop. Survives with the tray-kept server.

import { listIdentities, resetSmtpNetworkCaches } from "./mail";
import { performSend, type SendContext } from "./send-core";
import {
  applyAttemptOutcome,
  type LaneAdapter,
  type LaneOutcome,
} from "./attempt-step";
import { recordSendEvent } from "./recent-sends";
import { getSettings } from "./queue-settings-store";
import { listTemplates } from "./templates-store";
import {
  blockedSenderSet,
  listActiveBlocks,
  type SenderBlock,
} from "./sender-blocks";
import {
  activeSenderEmails,
  capFor,
  chooseBumpTemplate,
  choosePooledSender,
  chooseSender,
  computeSendPlan,
  effectiveDailyCap,
  hasDifferentFreeSender,
  localEligible,
  noteNetworkFailure,
  noteNetworkOk,
  noteSent,
  planPayload,
  pooledEligibility,
  senderAllowed,
  withinWindow,
  TICK_MS,
  type PlanInputs,
  type SendPlan,
  type SendPlanState,
} from "./send-plan";
import {
  claimDueBump,
  claimNextQueuedOpener,
  claimRepliedFollowup,
  distinctClientsToday,
  lastSenderForContact,
  listBumpCandidates,
  listPendingOpeners,
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

const MAX_ATTEMPTS = 3;

type WorkerState = SendPlanState & {
  gen: number;
  /**
   * Completion of the most recently armed loop (and everything chained after
   * it). A new arm awaits this before running crash recovery, so a successor
   * can never flip a row the retiring loop is still mid-send on.
   */
  running: Promise<void> | null;
  /**
   * The newest module instance's scheduling pass. The loop calls through this
   * pointer every iteration — see the publish note below the state setup.
   */
  tick: () => Promise<void>;
  lastError: string;
  lastSentAt: string | null;
  /**
   * The plan the last tick computed and executed — cached so the status
   * endpoint serves the very Send plan the worker acted on, staleness bounded
   * by the tick. Null until the first tick of a freshly booted process.
   */
  plan: SendPlan | null;
};

const globalForWorker = globalThis as unknown as { __queueWorker?: WorkerState };
const state: WorkerState = globalForWorker.__queueWorker ?? {
  gen: 0,
  running: null,
  tick,
  lastSendMs: 0,
  rotateIndex: 0,
  bumpIndex: 0,
  lastSender: "",
  lastError: "",
  lastSentAt: null,
  netBackoffMs: 0,
  offlineSince: null,
  netRetryAt: 0,
  plan: null,
};
globalForWorker.__queueWorker = state;

// Publish this module instance's tick so the running loop always executes the
// newest compiled code. Deliberately NOT a lifecycle action (ADR-0002): it
// retires nothing and arms nothing — the same single loop simply calls through
// the pointer. In production every copy of this module is built from the same
// source, so the swap changes nothing; in dev it is what lets an HMR reload of
// this file reach the loop on its next tick, with no server restart. (Next
// runs instrumentation's register() once per server process and caches it, so
// a re-arm can never be the HMR path.)
state.tick = tick;

// Backfill fields added after an older module instance created this state.
state.bumpIndex = Number.isFinite(state.bumpIndex) ? state.bumpIndex : 0;
state.netBackoffMs = Number.isFinite(state.netBackoffMs) ? state.netBackoffMs : 0;
state.netRetryAt = Number.isFinite(state.netRetryAt) ? state.netRetryAt : 0;
state.offlineSince = state.offlineSince ?? null;
state.plan = state.plan ?? null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The pure decisions take and return SendPlanState; these bridge it to the
// module-global singleton (which persists across HMR module instances).
function ramState(): SendPlanState {
  return {
    lastSendMs: state.lastSendMs,
    rotateIndex: state.rotateIndex,
    bumpIndex: state.bumpIndex,
    lastSender: state.lastSender,
    netBackoffMs: state.netBackoffMs,
    offlineSince: state.offlineSince,
    netRetryAt: state.netRetryAt,
  };
}

function applyRam(next: SendPlanState): void {
  state.lastSendMs = next.lastSendMs;
  state.rotateIndex = next.rotateIndex;
  state.bumpIndex = next.bumpIndex;
  state.lastSender = next.lastSender;
  state.netBackoffMs = next.netBackoffMs;
  state.offlineSince = next.offlineSince;
  state.netRetryAt = next.netRetryAt;
}

/** Record a link failure and return how long the loop should now wait. */
function recordNetworkFailure(error: string): number {
  const r = noteNetworkFailure(ramState(), Date.now());
  if (r.firstDrop) {
    // First drop of this outage: the DoH-resolved IP (and the transport pinned
    // to it) can be stale by the time we're back, so force a re-resolve rather
    // than retrying a dead address for the length of the DNS TTL.
    resetSmtpNetworkCaches();
    console.warn(`[queue] connection lost — holding the queue: ${error}`);
  }
  applyRam(r.nextState);
  state.lastError = error;
  return r.waitMs;
}

/** Clear the outage after anything actually gets through. */
function recordNetworkOk(): void {
  const r = noteNetworkOk(ramState());
  if (r.restored) console.log("[queue] connection restored");
  applyRam(r.nextState);
}

/** Stamp a completed wire attempt (drip spacing + sender alternation). */
function recordAttempt(sender: string): void {
  applyRam(noteSent(ramState(), Date.now(), sender));
}

// Non-pooled Sender choice through the plan's rotation. Returns "" when
// nothing may send — every caller must treat that as "hold this item".
function pickSender(itemFrom: string, blocked = blockedSenderSet()): string {
  const r = chooseSender(
    ramState(),
    {
      settings: getSettings(),
      identities: listIdentities().map((i) => i.email),
      blocked,
    },
    itemFrom,
  );
  applyRam(r.nextState);
  return r.sender;
}

// Next bump template body (rotating across the whole library), {{name}}
// substituted. Returns null when there are no bump templates.
function nextBumpBody(name: string): string | null {
  const r = chooseBumpTemplate(
    ramState(),
    listTemplates("bump").map((t) => t.body),
  );
  applyRam(r.nextState);
  if (r.body === null) return null;
  const who = (name || "").trim() || "there";
  return r.body.replace(/\{\{\s*name\s*\}\}/gi, who);
}

function replySubject(openerSubject: string): string {
  const s = openerSubject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// --- the attempt Lanes as data ----------------------------------------------
// Each lane is a label for the log lines, the send-event kind, and the
// store-backed LaneAdapter the attempt step drives. The transient / policy /
// success / fail policy itself lives ONCE in applyAttemptOutcome
// (lib/attempt-step.ts); nothing lane-specific below decides an outcome.

type LaneSpec = {
  label: string;
  eventKind: "opener" | "followup";
  adapter: LaneAdapter;
};

function pitchLane(fu: Sequence): LaneSpec {
  return {
    // Glossary term for the log lines; the store still says "followup" in its
    // carried-over identifiers and event kinds.
    label: "pitch",
    eventKind: "followup",
    adapter: {
      revert: () => revertFollowupToScheduled(fu.id),
      markSent: (messageId) => markFollowupSent(fu.id, messageId),
      markFailed: (error) => markFollowupFailed(fu.id, error, MAX_ATTEMPTS),
    },
  };
}

function openerLane(op: Sequence): LaneSpec {
  return {
    label: "opener",
    eventKind: "opener",
    adapter: {
      revert: () => revertOpenerToPending(op.id),
      // Persist the account that actually sent, so the threaded follow-up
      // replies from the same address.
      markSent: (messageId, sender) => markOpenerSent(op.id, messageId, sender),
      markFailed: (error) => markOpenerFailed(op.id, error, MAX_ATTEMPTS),
    },
  };
}

function bumpLane(seq: Sequence): LaneSpec {
  return {
    label: "bump",
    eventKind: "followup",
    adapter: {
      // claimDueBump stamped bump_sent_at as it claimed; un-stamp so the one
      // chance isn't consumed. For an offline revert the spin risk below
      // doesn't apply — the revert is followed by the offline backoff, not an
      // immediate re-claim.
      revert: () => revertBump(seq.id),
      // Already stamped at claim — success has nothing left to write.
      markSent: () => {},
      // A bump has no attempt counter, and reverting here would be wrong: a
      // permanently-failing one (dead address) would be re-claimed every
      // interval forever — re-mailing a bad address and, since claims are
      // ORDER BY op_sent_at ASC, starving every bump queued behind it. The one
      // chance is simply spent.
      markFailed: () => {},
    },
  };
}

// The one attempt step for all three Lanes: put the claimed item on the wire,
// apply the outcome policy through the lane's adapter, and do the lane-agnostic
// shell bookkeeping (offline backoff, drip stamp, status fields, log lines).
async function attemptSend(lane: LaneSpec, ctx: SendContext): Promise<LaneOutcome> {
  const result = await performSend(ctx);
  const step = applyAttemptOutcome(result, lane.adapter);
  if (step.outcome === "offline") {
    // Nothing left the machine — the item is already back untouched; hold the
    // whole loop until the link returns.
    console.warn(`[queue] ${lane.label} held (offline) → ${ctx.to}`);
    recordNetworkFailure(step.error);
    return "offline";
  }
  // Non-transient means we reached Gmail and it answered — whatever it said,
  // the link is up.
  recordNetworkOk();
  recordAttempt(ctx.fromEmail);
  if (step.disposition === "sent") {
    recordSendEvent(ctx.to, lane.eventKind, step.sender);
    state.lastError = "";
    state.lastSentAt = new Date().toISOString();
    console.log(`[queue] ${lane.label} sent → ${ctx.to} (as ${step.sender})`);
  } else if (step.disposition === "sender-blocked") {
    state.lastError = step.error;
    console.warn(`[queue] ${lane.label} held (sender blocked) → ${ctx.to}`);
  } else {
    state.lastError = step.error;
    console.warn(`[queue] ${lane.label} failed → ${ctx.to}: ${step.error}`);
  }
  return "attempted";
}

// The Pitch and Bump lanes both send as a threaded reply to the sequence's
// opener, from an already-chosen Sender.
function threadedReplyContext(
  seq: Sequence,
  body: string,
  sender: string,
): SendContext {
  return {
    to: seq.toEmail,
    // Keep the same Cc as the opener so the thread stays consistent.
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
  };
}

// Send one sequence's Pitch as a threaded reply to its opener. See sendBump
// for why the caller must sleep when nothing was attempted.
async function sendFollowup(fu: Sequence): Promise<LaneOutcome> {
  const lane = pitchLane(fu);
  const sender = pickSender(fu.fromEmail);
  if (!sender) {
    // The account went into a block between the claim and here. Put the step
    // back untouched — it fires tomorrow rather than burning an attempt.
    lane.adapter.revert();
    return "held";
  }
  return attemptSend(lane, threadedReplyContext(fu, fu.fuBody, sender));
}

// Send a one-time link-free bump to a non-replier as a threaded reply. The
// sequence stays 'scheduled' (bump_sent_at already stamped by claimDueBump), so
// a later reply still triggers the pitch.
//
// The caller must sleep whenever nothing was attempted: the bump lane ends its
// tick there, and the paths below that bail early leave the last-send stamp
// untouched, so without a sleep the loop would re-claim and spin with no timer
// in it.
async function sendBump(seq: Sequence): Promise<LaneOutcome> {
  const lane = bumpLane(seq);
  const body = nextBumpBody(seq.name);
  if (!body) {
    lane.adapter.revert(); // no bump templates — don't consume the one chance
    return "held";
  }
  const sender = pickSender(seq.fromEmail);
  if (!sender) {
    lane.adapter.revert();
    return "held";
  }
  return attemptSend(lane, threadedReplyContext(seq, body, sender));
}

/** Send a claimed opener from the already-chosen Sender. */
async function sendOpener(op: Sequence, sender: string): Promise<LaneOutcome> {
  return attemptSend(openerLane(op), {
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
}

// One scheduling pass: gather the Send plan's inputs, run the pure decision,
// and execute the plan's first due action — walking the attempt Lanes in
// priority order until a Claim lands. Ends with whatever pacing sleep the
// outcome calls for. The loop calls it through state.tick, so the pass that
// runs is always the newest module instance's — see the publish note by the
// state declaration.
async function tick(): Promise<void> {
  try {
    const s = getSettings();
    // One snapshot per tick, threaded into every decision below so a single
    // claim scan can't issue 200 queries.
    const blocked = blockedSenderSet();
    const identities = listIdentities().map((i) => i.email);
    const load = sentTodayBySender();
    const inputs: PlanInputs = {
      nowMs: Date.now(),
      random: Math.random(),
      settings: s,
      identities,
      blockedSenders: [...blocked],
      sentTodayBySender: load,
      distinctClientsToday: distinctClientsToday(),
      openers: listPendingOpeners(),
      bumps: listBumpCandidates(),
      bumpTemplateCount: listTemplates("bump").length,
    };
    const { plan, nextState } = computeSendPlan(ramState(), inputs);
    // The pure decision can clear a stale outage (retry deadline long missed);
    // announce that transition exactly as a send-cleared outage would be.
    if (state.netBackoffMs > 0 && nextState.netBackoffMs === 0) {
      console.log("[queue] connection restored");
    }
    applyRam(nextState);
    // Cache what this tick is about to execute — the status endpoint serves
    // exactly this plan (ticket 05), so the UI never re-derives it.
    state.plan = plan;

    const anyFree = identities.some((i) => !blocked.has(i.toLowerCase()));
    const elig = pooledEligibility(s, identities, load, blocked);

    for (const lane of plan.attempt) {
      if (lane === "pitch") {
        // Pass the eligibility filter ONLY when something is actually blocked:
        // with no predicate the claim runs LIMIT 1, with one it scans 200 rows
        // through a correlated EXISTS subquery. Keep the common path identical.
        const hot = claimRepliedFollowup(
          3,
          blocked.size > 0
            ? (seq) => senderAllowed(seq.fromEmail, blocked, anyFree)
            : undefined,
        );
        if (hot) {
          const outcome = await sendFollowup(hot);
          if (outcome === "offline") await sleep(state.netBackoffMs);
          else if (outcome === "held") await sleep(TICK_MS);
          return;
        }
        // Empty-handed: the only cheap proof "no Pitch is waiting" the Bump
        // lane's turn relies on. Note its blind spots: a reply the sync loop
        // hasn't recorded yet and an opener younger than the 3-minute floor
        // both read as "clear".
      } else if (lane === "opener") {
        // HARD RULE folded into claim eligibility: a re-send must not reuse
        // the account that already emailed the contact — SKIP (don't claim)
        // any opener whose only free account is its original Sender.
        const op = claimNextQueuedOpener((seq) => {
          if (!localEligible(seq.timezone, s, Date.now())) return false;
          // No pool → the item's own Sender is used verbatim, so it must be free.
          if (elig !== "ok") return senderAllowed(seq.fromEmail, blocked, anyFree);
          return hasDifferentFreeSender(
            s,
            identities,
            lastSenderForContact(seq.toEmail),
            load,
            blocked,
          );
        });
        if (!op) continue; // nothing claimable — the Bump lane may take the tick
        // Pool active → a FREE account different from the one that already
        // emailed this contact is guaranteed by the eligibility check above.
        // If somehow gone (race), put the opener back rather than reuse the
        // original sender.
        let sender: string;
        if (elig === "ok") {
          const picked = choosePooledSender(
            ramState(),
            { settings: s, identities, blocked, load },
            lastSenderForContact(op.toEmail),
          );
          applyRam(picked.nextState);
          if (!picked.sender) {
            revertOpenerToPending(op.id);
            await sleep(TICK_MS);
            return;
          }
          sender = picked.sender;
        } else {
          sender = pickSender(op.fromEmail, blocked);
          if (!sender) {
            revertOpenerToPending(op.id);
            await sleep(TICK_MS);
            return;
          }
        }
        const outcome = await sendOpener(op, sender);
        // The offline backoff state was just written by the attempt step, so
        // this sleeps exactly the wait recordNetworkFailure computed.
        if (outcome === "offline") await sleep(state.netBackoffMs);
        return;
      } else {
        // Bump: lowest Lane. The plan only opens it on a tick where the Pitch
        // lane ran empty-handed and the Opener queue is fully drained, and the
        // Opener branch above only falls through here on a null claim — so a
        // Bump can never jump the drip gap on the same tick as another send.
        //
        // Gate in the PREDICATE, never after the claim: claimDueBump stamps
        // bump_sent_at as it claims and only ever claims rows where that is
        // NULL, so an early return here would lose the bump forever.
        const bump = claimDueBump(
          s.bumpAfterDays,
          (seq) =>
            localEligible(seq.timezone, s, Date.now()) &&
            senderAllowed(seq.fromEmail, blocked, anyFree),
        );
        if (bump) {
          const outcome = await sendBump(bump);
          if (outcome === "offline") await sleep(state.netBackoffMs);
          else if (outcome === "held") await sleep(TICK_MS);
          return;
        }
      }
    }
    await sleep(plan.holdMs);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    await sleep(TICK_MS);
  }
}

async function loop(myGen: number): Promise<void> {
  // Guarded because it runs OUTSIDE tick's own try: a throw here (a locked DB
  // on a cold boot, say) would kill the engine before it ever reached the
  // loop, and nothing would send until the app was restarted.
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
    await state.tick();
  }
}

// --- Lifecycle (ADR-0002) ----------------------------------------------------
// instrumentation.ts is the sole armer; module scope resets nothing and starts
// nothing. Arms are CHAINED on `state.running`: a new generation's loop (and
// its crash recovery) only begins once the retired loop has fully exited, and
// the retired loop only exits at an iteration boundary — never mid-send. So a
// successor's recovery can't flip a row a live loop is still sending, which is
// the double-send hazard the old self-start convention could only ward off
// with a module-scope rule.

export function startQueueWorker(): void {
  // Bumping the generation retires the running loop at its next safe point;
  // repeated arms are harmless (each supersedes the one before).
  state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
  const myGen = state.gen;
  const prev = state.running ?? Promise.resolve();
  state.running = prev
    .then(() => {
      // A newer start (or a stop) won while the old loop drained — never arm
      // a stale generation.
      if (state.gen !== myGen) return;
      console.log("[queue] two-step engine armed");
      return loop(myGen);
    })
    .catch((err) => {
      console.error("[queue] engine stopped unexpectedly:", err);
    });
}

/**
 * Retire the running loop without arming a replacement. Resolves once the
 * loop has fully exited — after that, no further tick runs and no send is
 * attempted until a subsequent start arms a fresh generation.
 */
export async function stopQueueWorker(): Promise<void> {
  state.gen = (Number.isFinite(state.gen) ? state.gen : 0) + 1;
  await state.running;
}

export function queueWorkerStatus() {
  const s = getSettings();
  const identities = listIdentities().map((i) => i.email);
  const sentToday = distinctClientsToday();
  const gap = Math.max(5, s.intervalSec) * 1000;
  const since = Date.now() - state.lastSendMs;
  const nextInSec =
    state.lastSendMs > 0 && since < gap ? Math.ceil((gap - since) / 1000) : 0;
  const load = sentTodayBySender();
  const totalCap = effectiveDailyCap(s, identities);
  // Openers held back by the hard "different sender" rule: only possible when
  // exactly ONE pool account is free — then contacts whose original sender is
  // that account have no different account and must wait. With 3+ accounts this
  // is almost always 0.
  const configured = new Set(identities.map((e) => e.toLowerCase()));
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
  const activeEmails = activeSenderEmails(s, identities);
  const allSendersBlocked =
    activeEmails.length > 0 && activeEmails.every((e) => blockedSet.has(e));
  // The link is down and the loop is waiting it out. Surfaced so the UI can say
  // so instead of rendering a next-send countdown that will never fire.
  const offline = state.netBackoffMs > 0;
  return {
    // The last tick's Send plan, reduced to its wire shape with the aggregates
    // computed server-side (next-send anchor, finish estimate). Null only
    // before the first tick of a freshly booted process. Every other field
    // below survives unchanged — deletions belong to ticket 06's reader audit.
    plan: state.plan ? planPayload(state.plan) : null,
    blockedSenders,
    allSendersBlocked,
    offline,
    offlineSince: state.offlineSince,
    retryInSec: offline
      ? Math.max(0, Math.ceil((state.netRetryAt - Date.now()) / 1000))
      : 0,
    enabled: s.enabled,
    withinWindow: withinWindow(s, Date.now()),
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
