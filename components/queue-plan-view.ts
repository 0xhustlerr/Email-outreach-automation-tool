// How the queue UI renders the Send plan (.scratch/send-plan ticket 06).
//
// Pure presentation over the plan payload: PlanEntry in → row text/title out.
// No scheduling arithmetic belongs here or anywhere else client-side — ETAs
// and Hold reasons arrive computed from the worker's own plan, and the UI's
// only remaining clock job is formatting them and ticking countdowns from
// server-provided anchors.

import type { HoldReason, PlanEntry } from "@/lib/send-plan";

/**
 * Short phrase for each Hold reason, rendered in row titles and the stat
 * strip. A Record over the closed HoldReason union on purpose: a member added
 * to the plan fails this module's typecheck until it gets a phrase here — it
 * can never reach the operator as a blank.
 */
export const HOLD_LABEL: Record<HoldReason, string> = {
  offline: "connection down — retrying",
  window: "outside the sending window",
  "local-window": "outside the contact's local sending window",
  "daily-cap": "daily cap reached — resets at midnight",
  "sender-blocked": "its Sender is blocked for today",
  "drip-gap": "waiting out the send interval",
  "opener-drain": "waiting for the queued Openers to drain",
  "not-due": "not due yet",
};

export type RowEta = { text: string; title: string };

// Wall-clock label for a send ETA, in this machine's timezone: "11:42" when it
// lands today, "Aug 15, 11:42" when it spills past midnight. No zone suffix —
// the tooltip carries the full timestamp if anyone needs to be sure.
export function fmtClock(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (new Date(nowMs).toDateString() === d.toDateString()) return time;
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

// The whole-queue finish estimate's label: "~9:05 PM today" while it lands
// today, "Aug 23, ~9:05 PM" once it spills across midnight.
export function fmtFinish(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (new Date(nowMs).toDateString() === d.toDateString()) return `~${time} today`;
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ~${time}`;
}

export function fmtCountdown(sec: number): string {
  if (sec <= 0) return "any moment";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// Absolute stamp for hover titles, with NO live countdown in it: the queue
// list re-renders every second, and a title string that changes each tick
// makes the browser dismiss the tooltip mid-read and restart the hover delay.
function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function holdTail(hold: HoldReason | null): string {
  return hold ? ` (${HOLD_LABEL[hold]})` : "";
}

/**
 * A pending Opener row's expected send time. Null promises nothing — either
 * the queue is paused (null ETA; the header already says so) or the plan
 * hasn't reached the UI yet (no entry).
 */
export function openerRowEta(
  entry: PlanEntry | undefined,
  nowMs: number,
): RowEta | null {
  if (!entry || entry.etaMs === null) return null;
  return {
    text: `~ sends at ${fmtClock(entry.etaMs, nowMs)}`,
    title: `The Send plan expects this Opener to send ${stamp(entry.etaMs)}${holdTail(entry.hold)}.`,
  };
}

const PITCH_TITLE =
  "Pitch (message 2) sends in-thread within minutes of a reply — a Pitch " +
  "outranks every queued Opener and Bump, so there is no timed send to wait for.";

/**
 * A sent-Opener row still waiting on its reply: the Pitch is reply-triggered,
 * so the one thing on a clock is the link-free Bump — shown in its honest
 * conditional form ("sends ~14:30 unless they reply"), because reply state is
 * claim-time knowledge the plan deliberately never sees.
 */
export function bumpRowEta(args: {
  entry: PlanEntry | undefined;
  bumpSentAt: string | null;
  bumpEnabled: boolean;
  nowMs: number;
}): RowEta {
  const base = "pitch on reply";
  if (args.bumpSentAt) {
    return {
      text: `${base} · bumped`,
      title: `${PITCH_TITLE}\nLink-free Bump sent ${stamp(new Date(args.bumpSentAt).getTime())}.`,
    };
  }
  if (!args.entry) {
    return {
      text: base,
      title: `${PITCH_TITLE}\n${
        args.bumpEnabled
          ? "No Bump is planned — the worker has no bump template to send from."
          : "Bumps are off — nothing else is in the Send plan."
      }`,
    };
  }
  if (args.entry.etaMs === null) {
    return {
      text: base,
      title: `${PITCH_TITLE}\nQueue paused — the Bump gets an expected time once sending resumes.`,
    };
  }
  return {
    text: `bump ~${fmtClock(args.entry.etaMs, args.nowMs)} unless they reply`,
    title: `${PITCH_TITLE}\nLink-free Bump expected ${stamp(args.entry.etaMs)} unless the contact replies first${holdTail(args.entry.hold)}.`,
  };
}
