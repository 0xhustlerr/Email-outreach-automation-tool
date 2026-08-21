// The Send plan — the queue's scheduling brain, as a pure state machine.
//
// computeSendPlan(state, inputs) → { plan, nextState } decides everything the
// worker used to decide inline: which Lane may attempt a claim this tick
// (Pitch > Opener > Bump, strict priority), how long to hold when nothing is
// due, and the ordered projection of every queued item — its ETA, or the typed
// Hold reason keeping it back. The worker's shell gathers the inputs, executes
// the plan's first due action through the transactional Claims, and the status
// endpoint will serve the very same plan (tickets 05–06).
//
// PURE by contract: no database, mail, or timer imports; the clock (nowMs) and
// the tick's jitter sample (random) are plain inputs. Worker RAM state —
// sender rotation, bump-template rotation, last send, network backoff — is an
// explicit input/output (SendPlanState), never a module global. That is what
// lets the golden-decision tables in send-plan.test.ts drive years of
// simulated ticks through it in a millisecond.
//
// The plan is ADVISORY (ADR-0001): Claims re-validate eligibility at send
// time, including reply-state facts this module deliberately never sees. That
// is why Bump entries are `conditional` — a Bump only stands if the contact
// stays quiet, and only the Claim can know — and why the Pitch lane appears in
// `attempt` but never in `entries`: which contacts replied is claim-time
// knowledge.

import { withinLocalWindow } from "./country";
import type { QueueSettings } from "./queue-settings-store";

export const TICK_MS = 10_000;
// Minimum gap before a reply-triggered Pitch fires. It bypasses the normal
// drip interval so warm leads get the pitch within a few minutes, but we still
// keep a small spacing so replies never cause a true back-to-back burst.
export const HOT_MIN_GAP_MS = 30_000;

// Offline backoff: same doubling shape as reply-sync-loop / bounce-watch so
// every background loop behaves alike on a bad connection.
const NET_BACKOFF_MIN_MS = 15_000;
const NET_BACKOFF_MAX_MS = 300_000;
// How far past a missed retry deadline the outage is considered over. Must
// comfortably exceed one send attempt's worst case (SMTP connect + greeting +
// socket timeouts), or a slow-failing retry would look like a cleared outage.
const NET_STALE_MS = 120_000;

const DAY_MS = 86_400_000;

/** One of the three kinds of send the worker can perform on a tick. */
export type Lane = "pitch" | "opener" | "bump";

/**
 * The single typed cause keeping an item from sending right now. Closed on
 * purpose: adding a gate to the loop must add a member here, and the compiler
 * then surfaces every place that has to render it. Each gate in the loop maps
 * to exactly one member:
 *   offline       — the link is down; the worker is waiting out its backoff
 *   window        — the global sending window is closed
 *   local-window  — the contact is outside their own local-time window
 *   daily-cap     — the day's contact ceiling (or every pooled account's own
 *                   cap) is spent; resets at local midnight
 *   sender-blocked— every Sender this item could use is stood down for the day
 *   drip-gap      — the interval since the last send hasn't elapsed yet
 *   opener-drain  — a Bump waiting for the Opener queue to fully drain
 *   not-due       — the item's own schedule (op_send_after / bump delay)
 *                   hasn't come round yet
 */
export type HoldReason =
  | "offline"
  | "window"
  | "local-window"
  | "daily-cap"
  | "sender-blocked"
  | "drip-gap"
  | "opener-drain"
  | "not-due";

export type PlanEntry = {
  id: number;
  lane: Lane;
  /** Epoch ms this item is expected to send, or null when nothing can be
   *  promised (queue paused). */
  etaMs: number | null;
  /** Why it isn't sending right now; null = due at its ETA. When several
   *  gates apply the most item-specific one wins (not-due first, then the
   *  queue-level gates in loop order). */
  hold: HoldReason | null;
  /** Bump entries only: the ETA stands only if the contact doesn't reply —
   *  reply state is claim-time knowledge the plan never sees. */
  conditional: boolean;
};

export type SendPlan = {
  computedAtMs: number;
  /** The queue's enabled flag, inverted. A paused queue still plans (and the
   *  Pitch lane still runs), but entries promise nothing. */
  paused: boolean;
  /**
   * The tick directive: which Lanes to attempt claims for, in strict priority
   * order. The worker walks this list; the first successful Claim is the tick's
   * send. Empty = every lane held. Bump appears only when the Pitch lane also
   * runs this tick — "no Pitch is waiting" is only proven by the Pitch claim
   * coming back empty.
   */
  attempt: Lane[];
  /** Pacing sleep for the tick when no attempted Claim lands anything. */
  holdMs: number;
  /** Every queued item in send order: Openers by id, then due Bumps by opener
   *  age, then not-yet-due Bumps. Pitches are absent by design (see module
   *  note). Bump entries exist only when the Bump lane can ever fire
   *  (enabled + at least one template). */
  entries: PlanEntry[];
};

/** The worker's RAM state, made explicit. Input and output of every decision —
 *  the module never mutates, it returns successors. */
export type SendPlanState = {
  /** Epoch ms of the last email that actually went down the wire. */
  lastSendMs: number;
  /** Sender rotation cursor (shared by the plain and pooled pickers). */
  rotateIndex: number;
  /** Bump-template rotation cursor. */
  bumpIndex: number;
  /** Last account any email actually went out from (lowercased). */
  lastSender: string;
  /** Current offline backoff, 0 when the link is healthy. */
  netBackoffMs: number;
  /** When the current outage started, null when healthy. */
  offlineSince: string | null;
  /** Epoch ms of the next attempt while offline (drives the UI countdown). */
  netRetryAt: number;
};

/** A pending queue-lane Opener, id ASC (the claim order). */
export type QueuedOpener = {
  id: number;
  fromEmail: string;
  timezone: string;
  opSendAfter: string | null;
};

/** A Bump candidate: sent Opener, no Bump yet — reply state deliberately
 *  unknown here. op_sent_at ASC (the claim order). */
export type QueuedBump = {
  id: number;
  fromEmail: string;
  timezone: string;
  opSentAt: string;
};

export type PlanInputs = {
  nowMs: number;
  /** Uniform [0,1) sample for this tick's jitter, injected to stay pure. */
  random: number;
  settings: QueueSettings;
  /** Configured Sender addresses, identity order, case as configured. */
  identities: string[];
  /** Senders stood down for the day (lowercased). */
  blockedSenders: string[];
  /** Distinct contacts each Sender mailed today (lowercased keys). */
  sentTodayBySender: Record<string, number>;
  distinctClientsToday: number;
  openers: QueuedOpener[];
  bumps: QueuedBump[];
  bumpTemplateCount: number;
};

// --- window & pacing rules ---------------------------------------------------

export function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map((n) => parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function inHmWindow(curMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  if (startMin < endMin) return curMin >= startMin && curMin < endMin;
  return curMin >= startMin || curMin < endMin; // window wraps midnight
}

/** Is the machine-local clock inside the global sending window? */
export function withinWindow(s: QueueSettings, nowMs: number): boolean {
  const now = new Date(nowMs);
  const cur = now.getHours() * 60 + now.getMinutes();
  return inHmWindow(cur, parseHm(s.windowStart), parseHm(s.windowEnd));
}

/** This tick's jittered drip gap. `random` is the tick's [0,1) sample. */
export function nextGapMs(s: QueueSettings, random: number): number {
  const jitter = s.jitterSec > 0 ? (random * 2 - 1) * s.jitterSec : 0;
  return Math.max(5, s.intervalSec + jitter) * 1000;
}

// When local-time sending is on, a contact is only eligible if it's currently
// inside their local window. Contacts with an unknown timezone fall through
// (withinLocalWindow returns true) and are governed by the global window.
export function localEligible(
  timezone: string,
  s: QueueSettings,
  nowMs: number,
): boolean {
  if (!s.localTimeSend) return true;
  return withinLocalWindow(
    timezone,
    parseHm(s.localStart),
    parseHm(s.localEnd),
    new Date(nowMs),
  );
}

// --- cap & pool rules --------------------------------------------------------

// An account's own daily cap from senderCaps; no entry = unlimited.
// Different accounts have different warm-up status, so each carries its
// own limit. (The legacy global per_sender_cap column is ignored.)
export function capFor(s: QueueSettings, email: string): number {
  const own = s.senderCaps[email];
  return own && own > 0 ? own : Infinity;
}

// The accounts actually sending: the configured pool, or all configured
// identities when no pool is set. Always lowercased + deduped.
//
// DELIBERATELY NOT blocked-aware, and neither is effectiveDailyCap below.
// distinctClientsToday counts contacts across ALL Senders, so dropping a
// blocked account here would shrink the day's ceiling below a count that still
// includes what that account already sent — freezing the healthy accounts for
// the rest of the day. Blocks and caps are orthogonal: caps live here, blocks
// live in eligiblePoolSenders.
export function activeSenderEmails(
  s: QueueSettings,
  identities: string[],
): string[] {
  const configured = [...new Set(identities.map((i) => i.toLowerCase()))];
  const pool = s.senderPool.filter((e) => configured.includes(e));
  return pool.length > 0 ? pool : configured;
}

// The daily cap is PER SENDER; the overall ceiling for the day is the sum of
// each active account's own cap. When any account is uncapped the sum is
// meaningless, so fall back to the legacy total dailyCap.
export function effectiveDailyCap(
  s: QueueSettings,
  identities: string[],
): number {
  const caps = activeSenderEmails(s, identities).map((e) => capFor(s, e));
  if (caps.length === 0 || !caps.every(Number.isFinite)) return s.dailyCap;
  return caps.reduce((a, b) => a + b, 0);
}

// Cheap gate before claiming an Opener:
//   "none"   -> no sender pool configured (use the item's own Sender)
//   "capped" -> a pool exists but every account hit its daily cap (wait)
//   "ok"     -> at least one pooled account is free
// ("capped" also covers "every pooled account is policy-blocked today" — the
// response is the same: wait, don't strand a Claim.)
export function pooledEligibility(
  s: QueueSettings,
  identities: string[],
  load: Record<string, number>,
  blocked: Set<string>,
): "none" | "capped" | "ok" {
  const configured = new Set(identities.map((i) => i.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  if (pool.length === 0) return "none";
  return pool.some((e) => (load[e] ?? 0) < capFor(s, e) && !blocked.has(e))
    ? "ok"
    : "capped";
}

// Under-cap, non-blocked pool accounts, optionally excluding one address.
// THE choke point for blocked Senders on the Opener path: choosePooledSender
// and hasDifferentFreeSender both route through here.
function eligiblePoolSenders(
  s: QueueSettings,
  identities: string[],
  avoidEmail: string,
  load: Record<string, number>,
  blocked: Set<string>,
): string[] {
  const configured = new Set(identities.map((i) => i.toLowerCase()));
  const pool = s.senderPool.filter((e) => configured.has(e));
  const avoid = avoidEmail.trim().toLowerCase();
  return pool.filter(
    (e) => (load[e] ?? 0) < capFor(s, e) && e !== avoid && !blocked.has(e),
  );
}

/** Is there a free account DIFFERENT from `avoidEmail`? Claim eligibility for
 *  the hard "never reuse the account that already emailed this contact" rule —
 *  an Opener whose only free account is its original Sender is never claimed. */
export function hasDifferentFreeSender(
  s: QueueSettings,
  identities: string[],
  avoidEmail: string,
  load: Record<string, number>,
  blocked: Set<string>,
): boolean {
  return eligiblePoolSenders(s, identities, avoidEmail, load, blocked).length > 0;
}

// Can this item's step go out right now, given the blocked accounts?
// from_email can be written lowercased or verbatim depending on the writer, so
// normalize before comparing. Legacy rows can still carry '' — those rotate,
// so they're eligible exactly when some account is free.
export function senderAllowed(
  fromEmail: string,
  blocked: Set<string>,
  anyFree: boolean,
): boolean {
  const from = fromEmail.trim().toLowerCase();
  return from ? !blocked.has(from) : anyFree;
}

// --- sender choice (rotation state in, rotation state out) -------------------

type SenderChoiceArgs = {
  settings: QueueSettings;
  identities: string[];
  blocked: Set<string>;
};

/** Non-pooled Sender choice, also used by the Pitch and Bump lanes (which
 *  reuse the Opener's account verbatim). Returns sender "" when nothing may
 *  send — every caller must treat that as "hold this item", never as a send
 *  with no From. */
export function chooseSender(
  state: SendPlanState,
  { settings, identities, blocked }: SenderChoiceArgs,
  pinnedFrom: string,
): { sender: string; nextState: SendPlanState } {
  const pinned = pinnedFrom.trim();
  if (pinned) {
    return {
      sender: blocked.has(pinned.toLowerCase()) ? "" : pinned,
      nextState: state,
    };
  }
  const ids = identities.filter((i) => !blocked.has(i.toLowerCase()));
  if (ids.length === 0) return { sender: "", nextState: state };
  if (!settings.rotateSenders) return { sender: ids[0], nextState: state };
  const sender = ids[state.rotateIndex % ids.length];
  return {
    sender,
    nextState: { ...state, rotateIndex: (state.rotateIndex + 1) % ids.length },
  };
}

/** Which account an Opener goes out from when a pool is active. HARD RULE:
 *  never reuse `avoidEmail` (the account that already emailed this contact) —
 *  returns null if the only free account is that one, so the caller holds the
 *  send until a different account has budget. Among the different free
 *  accounts, ALTERNATE away from the last account used (no back-to-back). */
export function choosePooledSender(
  state: SendPlanState,
  args: SenderChoiceArgs & { load: Record<string, number> },
  avoidEmail: string,
): { sender: string | null; nextState: SendPlanState } {
  const candidates = eligiblePoolSenders(
    args.settings,
    args.identities,
    avoidEmail,
    args.load,
    args.blocked,
  );
  if (candidates.length === 0) return { sender: null, nextState: state };
  if (candidates.length === 1) return { sender: candidates[0], nextState: state };
  const others = candidates.filter((e) => e !== state.lastSender);
  const pickFrom = others.length > 0 ? others : candidates;
  const chosen = pickFrom[state.rotateIndex % pickFrom.length];
  return {
    sender: chosen,
    nextState: {
      ...state,
      rotateIndex: (state.rotateIndex + 1) % Math.max(1, pickFrom.length),
    },
  };
}

/** Next Bump template body, rotating across the whole library. Null when the
 *  library is empty — no Bump may send, and the rotation stands still. */
export function chooseBumpTemplate(
  state: SendPlanState,
  bodies: string[],
): { body: string | null; nextState: SendPlanState } {
  if (bodies.length === 0) return { body: null, nextState: state };
  const body = bodies[state.bumpIndex % bodies.length];
  return {
    body,
    nextState: { ...state, bumpIndex: (state.bumpIndex + 1) % bodies.length },
  };
}

// --- offline backoff ---------------------------------------------------------
// A dropped connection is a fault of the LINK, not of the contact being
// mailed, so a transient send failure marks nothing failed and burns no
// attempt: the step goes straight back to its queued state and the whole loop
// waits out `waitMs`.

/** Record a link failure. `firstDrop` marks the start of an outage — the shell
 *  uses it to reset SMTP network caches (a stale DoH-resolved IP would
 *  otherwise be retried for the length of the DNS TTL). */
export function noteNetworkFailure(
  state: SendPlanState,
  nowMs: number,
): { nextState: SendPlanState; waitMs: number; firstDrop: boolean } {
  const firstDrop = state.netBackoffMs === 0;
  const backoff = Math.min(
    NET_BACKOFF_MAX_MS,
    Math.max(NET_BACKOFF_MIN_MS, state.netBackoffMs * 2),
  );
  return {
    firstDrop,
    waitMs: backoff,
    nextState: {
      ...state,
      netBackoffMs: backoff,
      netRetryAt: nowMs + backoff,
      offlineSince: firstDrop ? new Date(nowMs).toISOString() : state.offlineSince,
    },
  };
}

/** Clear the outage after anything actually gets through. */
export function noteNetworkOk(state: SendPlanState): {
  nextState: SendPlanState;
  restored: boolean;
} {
  return {
    restored: state.netBackoffMs > 0,
    nextState: { ...state, netBackoffMs: 0, offlineSince: null, netRetryAt: 0 },
  };
}

/** Stamp a completed wire attempt: the drip spacing restarts from here, and
 *  the next Opener alternates away from this account. */
export function noteSent(
  state: SendPlanState,
  nowMs: number,
  sender: string,
): SendPlanState {
  return {
    ...state,
    lastSendMs: nowMs,
    lastSender: sender ? sender.toLowerCase() : state.lastSender,
  };
}

// --- the state machine -------------------------------------------------------

export function computeSendPlan(
  state: SendPlanState,
  inputs: PlanInputs,
): { plan: SendPlan; nextState: SendPlanState } {
  const { nowMs, settings: s } = inputs;

  // Only a successful send clears the outage — but if the queue emptied, was
  // paused, hit its cap or left its window while we were down, no send is
  // coming to clear it. Once the retry deadline has passed with no attempt
  // made, the network is no longer what's holding anything back.
  let nextState = state;
  if (state.netBackoffMs > 0 && nowMs > state.netRetryAt + NET_STALE_MS) {
    nextState = { ...state, netBackoffMs: 0, offlineSince: null, netRetryAt: 0 };
  }

  const blocked = new Set(inputs.blockedSenders.map((e) => e.toLowerCase()));
  const anyFree = inputs.identities.some((i) => !blocked.has(i.toLowerCase()));
  const sinceLast = nowMs - nextState.lastSendMs;
  const load = inputs.sentTodayBySender;
  const capPerDay = effectiveDailyCap(s, inputs.identities);
  const capReached = inputs.distinctClientsToday >= capPerDay;
  const elig = pooledEligibility(s, inputs.identities, load, blocked);

  // -- the tick directive: which lanes may attempt a Claim, in priority order
  const attempt: Lane[] = [];
  // Pitch first: the opener already got a reply → send the pitch fast (a small
  // spacing only, bypassing enabled/window/cap and the drip interval) while
  // the lead is warm.
  const pitchOpen =
    (nextState.lastSendMs === 0 || sinceLast >= HOT_MIN_GAP_MS) && anyFree;
  if (pitchOpen) attempt.push("pitch");

  let holdMs = TICK_MS;
  const gap = nextGapMs(s, inputs.random);
  const dripSpacingHolds = nextState.lastSendMs > 0 && sinceLast < gap;
  if (dripSpacingHolds) {
    // Respect send spacing for the normal drip (one email per interval).
    holdMs = Math.min(gap - sinceLast, TICK_MS);
  } else {
    // Openers: gated by enabled + window + total cap. The window is the global
    // window in normal mode; local-time mode gates per recipient instead (in
    // the Claim predicate), so the drip runs across all hours.
    const globalWindowOk = s.localTimeSend || withinWindow(s, nowMs);
    const dripOpen =
      s.enabled &&
      globalWindowOk &&
      !capReached &&
      elig !== "capped" && // pool exists but every account capped/blocked: wait
      (elig === "ok" || anyFree); // no pool + all blocked: nothing can send
    if (dripOpen) {
      attempt.push("opener");
      // Bump last: held until the Opener queue is FULLY drained (a scheduled
      // Opener still counts — drained is a statement about the whole queue,
      // not this instant) and the Pitch lane ran this same tick, since only
      // its empty-handed Claim proves no Pitch is waiting.
      if (
        s.bumpEnabled &&
        anyFree &&
        pitchOpen &&
        inputs.openers.length === 0 &&
        inputs.bumpTemplateCount > 0
      ) {
        attempt.push("bump");
      }
    }
  }

  return {
    plan: {
      computedAtMs: nowMs,
      paused: !s.enabled,
      attempt,
      holdMs,
      entries: projectEntries(nextState, inputs, {
        blocked,
        anyFree,
        capPerDay,
        capReached,
        elig,
        dripSpacingHolds,
      }),
    },
    nextState,
  };
}

// --- the status-seam payload -------------------------------------------------

/** What the queue status endpoint serves: the worker's cached plan reduced to
 *  its wire shape. The tick directive (attempt/holdMs) stays private to the
 *  worker — the UI renders entries, it doesn't execute them. */
export type SendPlanPayload = Pick<
  SendPlan,
  "computedAtMs" | "paused" | "entries"
> & {
  /** Countdown anchor: epoch ms of the earliest predicted ETA. Null when the
   *  queue is empty or paused (nothing is predicted). Not simply the head
   *  entry's — the Claims skip not-due rows, so a head not due until next week
   *  doesn't hide an item sending in a minute. */
  nextSendAtMs: number | null;
  /** Whole-queue finish estimate: epoch ms of the latest predicted ETA. A
   *  not-yet-due Bump's due floor holds the queue open past the last drip
   *  slot. Null when nothing is predicted. */
  finishAtMs: number | null;
};

/** Reduce a plan to the payload the status endpoint ships. Pure: aggregates
 *  come from the plan's own entries, never re-derived from settings — that
 *  re-derivation is exactly the mirror drift this seam exists to end. */
export function planPayload(plan: SendPlan): SendPlanPayload {
  const etas = plan.entries
    .map((e) => e.etaMs)
    .filter((ms): ms is number => ms !== null);
  return {
    computedAtMs: plan.computedAtMs,
    paused: plan.paused,
    entries: plan.entries,
    nextSendAtMs: etas.length > 0 ? Math.min(...etas) : null,
    finishAtMs: etas.length > 0 ? Math.max(...etas) : null,
  };
}

// --- the projection ----------------------------------------------------------

type ProjectionCtx = {
  blocked: Set<string>;
  anyFree: boolean;
  capPerDay: number;
  capReached: boolean;
  elig: "none" | "capped" | "ok";
  dripSpacingHolds: boolean;
};

/** Every queued item in send order with its projected ETA: walk the worker's
 *  own gates (window, daily cap with its midnight reset, drip spacing) slot by
 *  slot instead of promising `now + rank × interval` clock times the worker
 *  would never honour. */
function projectEntries(
  state: SendPlanState,
  inputs: PlanInputs,
  ctx: ProjectionCtx,
): PlanEntry[] {
  const { nowMs, settings: s } = inputs;

  // A paused queue promises nothing: the header-level fact (plan.paused) is
  // the whole story, so entries carry neither an ETA nor a hold.
  if (!s.enabled) {
    const rows: PlanEntry[] = inputs.openers.map((o) => ({
      id: o.id,
      lane: "opener",
      etaMs: null,
      hold: null,
      conditional: false,
    }));
    if (s.bumpEnabled && inputs.bumpTemplateCount > 0) {
      for (const b of inputs.bumps) {
        rows.push({ id: b.id, lane: "bump", etaMs: null, hold: null, conditional: true });
      }
    }
    return rows;
  }

  const bumpsPossible = s.bumpEnabled && inputs.bumpTemplateCount > 0;
  const dueAt = (b: QueuedBump) =>
    new Date(b.opSentAt).getTime() + s.bumpAfterDays * DAY_MS;
  // Due Bumps take drip slots after the Openers, oldest opener first (the
  // Claim's ORDER BY op_sent_at). Not-yet-due ones just carry their due floor.
  const orderedBumps = bumpsPossible
    ? [...inputs.bumps].sort(
        (a, b) => dueAt(a) - dueAt(b) || a.id - b.id,
      )
    : [];
  const dueBumps = orderedBumps.filter((b) => dueAt(b) <= nowMs);
  const laterBumps = orderedBumps.filter((b) => dueAt(b) > nowMs);

  // -- slot walk
  const intervalMs = Math.max(5, s.intervalSec) * 1000;
  const startMin = parseHm(s.windowStart);
  const endMin = parseHm(s.windowEnd);
  const windowed = !s.localTimeSend && startMin !== endMin;
  const dayKey = (ms: number) => new Date(ms).toDateString();
  const minutesOf = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  };
  const nextWindowStart = (ms: number) => {
    const d = new Date(ms);
    d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
    return d.getTime();
  };
  const nextMidnight = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return d.getTime();
  };

  // Start from the end of the current send-spacing gap, not from `now`: the
  // first slot isn't due until the interval since the last send elapses.
  // Unjittered — the projection promises the steady pace, not one tick's coin
  // flip.
  const sinceLast = nowMs - state.lastSendMs;
  let t =
    nowMs +
    (state.lastSendMs > 0 && sinceLast < intervalMs ? intervalMs - sinceLast : 0);
  if (s.startAt) {
    const startAtMs = new Date(s.startAt).getTime();
    if (Number.isFinite(startAtMs)) t = Math.max(t, startAtMs);
  }
  let day = dayKey(t);
  let capLeft = Math.max(0, ctx.capPerDay - inputs.distinctClientsToday);
  const nextSlot = (): number => {
    // Push t forward until it lands on a moment the worker would send in:
    // inside the window, on a day with cap headroom left. Every slot spends
    // cap — a Bump's contact isn't in today's send log either.
    for (let guard = 0; guard < 400; guard++) {
      if (windowed && !inHmWindow(minutesOf(t), startMin, endMin)) {
        t = nextWindowStart(t);
      }
      if (dayKey(t) !== day) {
        day = dayKey(t);
        capLeft = Number.isFinite(ctx.capPerDay) ? ctx.capPerDay : Infinity;
      }
      if (capLeft <= 0) {
        t = nextMidnight(t); // cap resets at local midnight; re-check window
        continue;
      }
      break;
    }
    const slot = t;
    capLeft -= 1;
    t += intervalMs;
    return slot;
  };

  // -- hold reasons, most item-specific first
  const offline = state.netBackoffMs > 0;
  const windowShut = windowed && !inHmWindow(minutesOf(nowMs), startMin, endMin);
  const poolAllBlocked =
    ctx.elig === "capped" &&
    s.senderPool.every((e) => ctx.blocked.has(e));
  const capHold = ctx.capReached || (ctx.elig === "capped" && !poolAllBlocked);
  const queueSenderHold =
    poolAllBlocked || (ctx.elig !== "ok" && !ctx.anyFree);
  const holdFor = (
    item: { fromEmail: string; timezone: string },
    lane: Lane,
    notDue: boolean,
    head: boolean,
  ): HoldReason | null => {
    if (notDue) return "not-due";
    if (offline) return "offline";
    if (windowShut) return "window";
    if (capHold) return "daily-cap";
    if (
      queueSenderHold ||
      (ctx.elig !== "ok" && !senderAllowed(item.fromEmail, ctx.blocked, ctx.anyFree))
    ) {
      return "sender-blocked";
    }
    if (s.localTimeSend && !localEligible(item.timezone, s, nowMs)) {
      return "local-window";
    }
    if (lane === "bump" && inputs.openers.length > 0) return "opener-drain";
    if (head && ctx.dripSpacingHolds) return "drip-gap";
    return null;
  };

  const entries: PlanEntry[] = [];
  for (const o of inputs.openers) {
    const sendAfterMs = o.opSendAfter ? new Date(o.opSendAfter).getTime() : 0;
    const slot = nextSlot();
    entries.push({
      id: o.id,
      lane: "opener",
      etaMs: Math.max(slot, sendAfterMs),
      hold: holdFor(o, "opener", sendAfterMs > nowMs, entries.length === 0),
      conditional: false,
    });
  }
  for (const b of dueBumps) {
    entries.push({
      id: b.id,
      lane: "bump",
      etaMs: nextSlot(),
      hold: holdFor(b, "bump", false, entries.length === 0),
      conditional: true,
    });
  }
  for (const b of laterBumps) {
    entries.push({
      id: b.id,
      lane: "bump",
      etaMs: dueAt(b),
      hold: "not-due",
      conditional: true,
    });
  }
  return entries;
}
