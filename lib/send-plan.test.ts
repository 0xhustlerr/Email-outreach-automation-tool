// Golden-decision tables for the Send plan (.scratch/send-plan ticket 03).
//
// Authored FIRST, from the queue worker's observable rules as of the extraction
// (lib/queue-worker.ts): each case reads as settings + state + items in →
// plan/action out. They are the strict-preservation proof — a behavioural diff
// introduced by the extraction shows up here as a red test, not a field report.
//
// Tests live at the module's public seam only: computeSendPlan and the pure
// execution-time helpers. Nothing here reaches into internals, the database, or
// timers — the clock and the tick's jitter sample are plain inputs.

import { describe, it, expect } from "vitest";
import {
  computeSendPlan,
  chooseSender,
  choosePooledSender,
  chooseBumpTemplate,
  noteNetworkFailure,
  noteNetworkOk,
  noteSent,
  localEligible,
  senderAllowed,
  hasDifferentFreeSender,
  pooledEligibility,
  effectiveDailyCap,
  planPayload,
  TICK_MS,
  type PlanInputs,
  type SendPlanState,
} from "./send-plan";
import type { QueueSettings } from "./queue-settings-store";

// --- builders ---------------------------------------------------------------

/** A local wall-clock instant (the worker's window math is machine-local). */
const at = (h: number, m: number, day = 20): number =>
  new Date(2026, 7, day, h, m, 0, 0).getTime();

const settings = (over: Partial<QueueSettings> = {}): QueueSettings => ({
  enabled: true,
  windowStart: "09:00",
  windowEnd: "18:00",
  intervalSec: 60,
  jitterSec: 0,
  dailyCap: 100,
  rotateSenders: true,
  startAt: null,
  fuDelayMin: 30,
  localTimeSend: false,
  localStart: "09:00",
  localEnd: "17:00",
  senderPool: [],
  perSenderCap: 0,
  senderCaps: {},
  bumpEnabled: false,
  bumpAfterDays: 2,
  ...over,
});

const state = (over: Partial<SendPlanState> = {}): SendPlanState => ({
  lastSendMs: 0,
  rotateIndex: 0,
  bumpIndex: 0,
  lastSender: "",
  netBackoffMs: 0,
  offlineSince: null,
  netRetryAt: 0,
  ...over,
});

const inputs = (over: Partial<PlanInputs> = {}): PlanInputs => ({
  nowMs: at(10, 0),
  random: 0.5,
  settings: settings(),
  identities: ["a@x.com", "b@x.com"],
  blockedSenders: [],
  sentTodayBySender: {},
  distinctClientsToday: 0,
  openers: [],
  bumps: [],
  bumpTemplateCount: 0,
  ...over,
});

const opener = (id: number, over: Partial<PlanInputs["openers"][number]> = {}) => ({
  id,
  fromEmail: "",
  timezone: "",
  opSendAfter: null as string | null,
  ...over,
});

const bump = (id: number, opSentAt: string, over: Partial<Omit<PlanInputs["bumps"][number], "id" | "opSentAt">> = {}) => ({
  id,
  fromEmail: "a@x.com",
  timezone: "",
  opSentAt,
  ...over,
});

const daysAgo = (days: number, fromMs: number): string =>
  new Date(fromMs - days * 86_400_000).toISOString();

// --- Lane priority: Pitch outranks Opener outranks Bump ----------------------

describe("lane priority", () => {
  it("attempts the Pitch lane first whenever it is open", () => {
    const { plan } = computeSendPlan(state(), inputs());
    expect(plan.attempt[0]).toBe("pitch");
  });

  it("a tick that has never sent opens the Pitch lane (no hot-gap wait)", () => {
    const { plan } = computeSendPlan(state({ lastSendMs: 0 }), inputs());
    expect(plan.attempt).toContain("pitch");
  });

  it("holds the Pitch lane inside the 30s hot gap", () => {
    const now = at(10, 0);
    const { plan } = computeSendPlan(
      state({ lastSendMs: now - 29_000 }),
      inputs({ nowMs: now }),
    );
    expect(plan.attempt).not.toContain("pitch");
  });

  it("opens the Pitch lane once the 30s hot gap has elapsed", () => {
    const now = at(10, 0);
    const { plan } = computeSendPlan(
      state({ lastSendMs: now - 30_000 }),
      inputs({ nowMs: now }),
    );
    expect(plan.attempt).toContain("pitch");
  });

  it("Pitch bypasses the enabled flag, window and daily cap", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: at(20, 0), // outside 09:00–18:00
        settings: settings({ enabled: false, dailyCap: 1 }),
        distinctClientsToday: 5,
      }),
    );
    expect(plan.attempt).toEqual(["pitch"]);
    expect(plan.holdMs).toBe(TICK_MS);
  });

  it("closes every lane, Pitch included, when every Sender is blocked", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({ blockedSenders: ["a@x.com", "b@x.com"] }),
    );
    expect(plan.attempt).toEqual([]);
    expect(plan.holdMs).toBe(TICK_MS);
  });

  it("attempts Pitch then Opener when the drip gates pass", () => {
    const { plan } = computeSendPlan(state(), inputs());
    expect(plan.attempt).toEqual(["pitch", "opener"]);
  });

  it("Bump joins last, only when Openers are drained and Pitch ran empty-handed", () => {
    const now = at(10, 0);
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ bumpEnabled: true }),
        bumps: [bump(7, daysAgo(3, now))],
        bumpTemplateCount: 1,
      }),
    );
    expect(plan.attempt).toEqual(["pitch", "opener", "bump"]);
  });
});

// --- Drip spacing (interval + jitter) ----------------------------------------

describe("drip spacing", () => {
  it("holds the drip while the interval gap is still running", () => {
    const now = at(10, 0);
    const { plan } = computeSendPlan(
      state({ lastSendMs: now - 40_000 }),
      inputs({ nowMs: now, settings: settings({ intervalSec: 60 }) }),
    );
    // Hot gap elapsed → Pitch still runs; the drip waits out the remainder,
    // capped at one tick.
    expect(plan.attempt).toEqual(["pitch"]);
    expect(plan.holdMs).toBe(Math.min(60_000 - 40_000, TICK_MS));
  });

  it("opens the drip once the interval has elapsed", () => {
    const now = at(10, 0);
    const { plan } = computeSendPlan(
      state({ lastSendMs: now - 61_000 }),
      inputs({ nowMs: now, settings: settings({ intervalSec: 60 }) }),
    );
    expect(plan.attempt).toEqual(["pitch", "opener"]);
  });

  it("jitter widens the gap at random=1 and narrows it at random=0", () => {
    const now = at(10, 0);
    const s = settings({ intervalSec: 60, jitterSec: 30 });
    // 80s since last send: a +30s jitter (gap 90s) still holds …
    const wide = computeSendPlan(
      state({ lastSendMs: now - 80_000 }),
      inputs({ nowMs: now, settings: s, random: 1 }),
    );
    expect(wide.plan.attempt).toEqual(["pitch"]);
    // … a −30s jitter (gap 30s) lets the same tick through.
    const narrow = computeSendPlan(
      state({ lastSendMs: now - 80_000 }),
      inputs({ nowMs: now, settings: s, random: 0 }),
    );
    expect(narrow.plan.attempt).toEqual(["pitch", "opener"]);
  });
});

// --- Sending window: open/close edges ----------------------------------------

describe("sending window edges", () => {
  const laneOpen = (nowMs: number, s = settings()) =>
    computeSendPlan(state(), inputs({ nowMs, settings: s })).plan.attempt.includes(
      "opener",
    );

  it("09:00–18:00 window: closed at 08:59, open at 09:00", () => {
    expect(laneOpen(at(8, 59))).toBe(false);
    expect(laneOpen(at(9, 0))).toBe(true);
  });

  it("09:00–18:00 window: open at 17:59, closed at 18:00", () => {
    expect(laneOpen(at(17, 59))).toBe(true);
    expect(laneOpen(at(18, 0))).toBe(false);
  });

  it("a wrap-around 22:00–06:00 window spans midnight", () => {
    const s = settings({ windowStart: "22:00", windowEnd: "06:00" });
    expect(laneOpen(at(23, 0), s)).toBe(true);
    expect(laneOpen(at(5, 59), s)).toBe(true);
    expect(laneOpen(at(6, 0), s)).toBe(false);
    expect(laneOpen(at(12, 0), s)).toBe(false);
  });

  it("start == end means the window is always open", () => {
    const s = settings({ windowStart: "09:00", windowEnd: "09:00" });
    expect(laneOpen(at(3, 30), s)).toBe(true);
  });

  it("local-time mode bypasses the global window entirely", () => {
    const s = settings({ localTimeSend: true });
    expect(laneOpen(at(20, 0), s)).toBe(true);
  });

  it("a held window shows as hold reason 'window' on queued Openers", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({ nowMs: at(8, 0), openers: [opener(1)] }),
    );
    expect(plan.entries[0]).toMatchObject({ id: 1, lane: "opener", hold: "window" });
  });
});

// --- Daily cap: exhaustion and midnight reset --------------------------------

describe("daily cap", () => {
  it("closes the drip when distinct contacts today reach the cap", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({ settings: settings({ dailyCap: 2 }), distinctClientsToday: 2 }),
    );
    expect(plan.attempt).toEqual(["pitch"]);
  });

  it("stays open one send below the cap", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({ settings: settings({ dailyCap: 2 }), distinctClientsToday: 1 }),
    );
    expect(plan.attempt).toEqual(["pitch", "opener"]);
  });

  it("the day's ceiling is the sum of per-Sender caps when every account is capped", () => {
    const s = settings({
      dailyCap: 100,
      senderPool: ["a@x.com", "b@x.com"],
      senderCaps: { "a@x.com": 5, "b@x.com": 3 },
    });
    expect(effectiveDailyCap(s, ["a@x.com", "b@x.com"])).toBe(8);
    const closed = computeSendPlan(
      state(),
      inputs({ settings: s, distinctClientsToday: 8 }),
    );
    expect(closed.plan.attempt).toEqual(["pitch"]);
  });

  it("an uncapped account makes the sum meaningless — fall back to the legacy total", () => {
    const s = settings({
      dailyCap: 40,
      senderPool: ["a@x.com", "b@x.com"],
      senderCaps: { "a@x.com": 5 },
    });
    expect(effectiveDailyCap(s, ["a@x.com", "b@x.com"])).toBe(40);
  });

  it("cap exhaustion holds queued Openers as 'daily-cap' with the reset in the ETA", () => {
    const now = at(10, 0);
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ dailyCap: 2 }),
        distinctClientsToday: 2,
        openers: [opener(1)],
      }),
    );
    const entry = plan.entries[0];
    expect(entry.hold).toBe("daily-cap");
    // Cap resets at local midnight; the 09:00 window start is the next real slot.
    expect(entry.etaMs).toBe(at(9, 0, 21));
  });

  it("a pool where every account hit its own cap holds the drip ('capped')", () => {
    const s = settings({
      senderPool: ["a@x.com", "b@x.com"],
      senderCaps: { "a@x.com": 2, "b@x.com": 2 },
    });
    const load = { "a@x.com": 2, "b@x.com": 2 };
    expect(pooledEligibility(s, ["a@x.com", "b@x.com"], load, new Set())).toBe(
      "capped",
    );
    const { plan } = computeSendPlan(
      state(),
      inputs({ settings: s, sentTodayBySender: load }),
    );
    expect(plan.attempt).toEqual(["pitch"]);
  });
});

// --- Opener drain: what gates the Bump lane ----------------------------------

describe("opener drain", () => {
  const now = at(10, 0);
  const bumpReady = (over: Partial<PlanInputs> = {}) =>
    inputs({
      nowMs: now,
      settings: settings({ bumpEnabled: true }),
      bumps: [bump(7, daysAgo(3, now))],
      bumpTemplateCount: 1,
      ...over,
    });

  it("a pending Opener keeps the Bump lane shut", () => {
    const { plan } = computeSendPlan(state(), bumpReady({ openers: [opener(1)] }));
    expect(plan.attempt).toEqual(["pitch", "opener"]);
    const bumpEntry = plan.entries.find((e) => e.lane === "bump");
    expect(bumpEntry?.hold).toBe("opener-drain");
  });

  it("an Opener scheduled for next week STILL counts — drained is about the whole queue", () => {
    const { plan } = computeSendPlan(
      state(),
      bumpReady({
        openers: [opener(1, { opSendAfter: new Date(now + 7 * 86_400_000).toISOString() })],
      }),
    );
    expect(plan.attempt).not.toContain("bump");
  });

  it("a Bump never goes out on a tick where the Pitch lane did not run", () => {
    // 15s since last send: past the 10s interval (drip open) but inside the
    // 30s hot gap — the Pitch lane can't prove no Pitch is waiting, so the
    // Bump stays shut even with the queue drained.
    const { plan } = computeSendPlan(
      state({ lastSendMs: now - 15_000 }),
      bumpReady({ settings: settings({ bumpEnabled: true, intervalSec: 10 }) }),
    );
    expect(plan.attempt).toEqual(["opener"]);
  });

  it("Bumps disabled or template-less never open the lane nor plan entries", () => {
    const off = computeSendPlan(
      state(),
      bumpReady({ settings: settings({ bumpEnabled: false }) }),
    );
    expect(off.plan.attempt).not.toContain("bump");
    expect(off.plan.entries.filter((e) => e.lane === "bump")).toEqual([]);

    const noTemplates = computeSendPlan(state(), bumpReady({ bumpTemplateCount: 0 }));
    expect(noTemplates.plan.attempt).not.toContain("bump");
    expect(noTemplates.plan.entries.filter((e) => e.lane === "bump")).toEqual([]);
  });
});

// --- Bump due-gating ---------------------------------------------------------

describe("bump due-gating", () => {
  const now = at(10, 0);

  it("a Bump inside its after-days delay holds as 'not-due' at its due time", () => {
    const opSentAt = daysAgo(1, now);
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ bumpEnabled: true, bumpAfterDays: 2 }),
        bumps: [bump(7, opSentAt)],
        bumpTemplateCount: 1,
      }),
    );
    const entry = plan.entries.find((e) => e.lane === "bump");
    expect(entry?.hold).toBe("not-due");
    expect(entry?.etaMs).toBe(new Date(opSentAt).getTime() + 2 * 86_400_000);
  });

  it("a due Bump on a drained queue is the plan's first due action", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ bumpEnabled: true, bumpAfterDays: 2 }),
        bumps: [bump(7, daysAgo(3, now))],
        bumpTemplateCount: 1,
      }),
    );
    const entry = plan.entries.find((e) => e.lane === "bump");
    expect(entry?.hold).toBeNull();
    expect(plan.attempt).toContain("bump");
  });

  it("every Bump entry is conditional — it only stands if the contact stays quiet", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ bumpEnabled: true }),
        bumps: [bump(7, daysAgo(3, now)), bump(8, daysAgo(1, now))],
        bumpTemplateCount: 1,
      }),
    );
    const bumps = plan.entries.filter((e) => e.lane === "bump");
    expect(bumps).toHaveLength(2);
    expect(bumps.every((e) => e.conditional)).toBe(true);
  });
});

// --- Offline backoff: doubling and staleness reset ---------------------------

describe("offline backoff", () => {
  const now = at(10, 0);

  it("the first drop starts at 15s and flags the outage start", () => {
    const r = noteNetworkFailure(state(), now);
    expect(r.firstDrop).toBe(true);
    expect(r.waitMs).toBe(15_000);
    expect(r.nextState.netBackoffMs).toBe(15_000);
    expect(r.nextState.netRetryAt).toBe(now + 15_000);
    expect(r.nextState.offlineSince).not.toBeNull();
  });

  it("repeat failures double up to the 300s ceiling", () => {
    let s = state();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = noteNetworkFailure(s, now);
      waits.push(r.waitMs);
      s = r.nextState;
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it("anything getting through clears the outage", () => {
    const down = noteNetworkFailure(state(), now).nextState;
    const r = noteNetworkOk(down);
    expect(r.restored).toBe(true);
    expect(r.nextState).toMatchObject({ netBackoffMs: 0, offlineSince: null, netRetryAt: 0 });
  });

  it("clearing an already-healthy link reports nothing restored", () => {
    expect(noteNetworkOk(state()).restored).toBe(false);
  });

  it("a retry deadline missed by over 120s reads as a cleared outage", () => {
    const stale = state({
      netBackoffMs: 60_000,
      netRetryAt: now - 121_000,
      offlineSince: new Date(now - 300_000).toISOString(),
    });
    const { nextState } = computeSendPlan(stale, inputs({ nowMs: now }));
    expect(nextState.netBackoffMs).toBe(0);
    expect(nextState.offlineSince).toBeNull();
  });

  it("a deadline missed by less shows the queue held as 'offline'", () => {
    const down = state({
      netBackoffMs: 60_000,
      netRetryAt: now - 119_000,
      offlineSince: new Date(now - 200_000).toISOString(),
    });
    const { plan, nextState } = computeSendPlan(
      down,
      inputs({ nowMs: now, openers: [opener(1)] }),
    );
    expect(nextState.netBackoffMs).toBe(60_000);
    expect(plan.entries[0].hold).toBe("offline");
  });
});

// --- Sender rotation skipping blocked Senders --------------------------------

describe("sender choice", () => {
  const ids = ["A@x.com", "b@x.com", "c@x.com"];
  const args = (blocked: string[] = [], over: Partial<QueueSettings> = {}) => ({
    settings: settings(over),
    identities: ids,
    blocked: new Set(blocked),
  });

  it("a pinned Sender is used verbatim, without advancing the rotation", () => {
    const r = chooseSender(state({ rotateIndex: 1 }), args(), "A@x.com");
    expect(r.sender).toBe("A@x.com");
    expect(r.nextState.rotateIndex).toBe(1);
  });

  it("a pinned but blocked Sender means hold — never a silent substitute", () => {
    const r = chooseSender(state(), args(["a@x.com"]), "A@x.com");
    expect(r.sender).toBe("");
  });

  it("rotation walks the free Senders and skips blocked ones", () => {
    let s = state();
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = chooseSender(s, args(["b@x.com"]), "");
      picks.push(r.sender);
      s = r.nextState;
    }
    expect(picks).toEqual(["A@x.com", "c@x.com", "A@x.com", "c@x.com"]);
  });

  it("with rotation off, the first free Sender always sends", () => {
    const r = chooseSender(state(), args(["a@x.com"], { rotateSenders: false }), "");
    expect(r.sender).toBe("b@x.com");
    expect(r.nextState.rotateIndex).toBe(0);
  });

  it("all Senders blocked → nobody may send", () => {
    const r = chooseSender(state(), args(["a@x.com", "b@x.com", "c@x.com"]), "");
    expect(r.sender).toBe("");
  });

  it("the pool pick never reuses the account that already emailed the contact", () => {
    const s = settings({ senderPool: ["a@x.com", "b@x.com"] });
    const r = choosePooledSender(
      state(),
      { settings: s, identities: ids, blocked: new Set(), load: {} },
      "a@x.com",
    );
    expect(r.sender).toBe("b@x.com");
  });

  it("holds (null) when the only free account is the one to avoid", () => {
    const s = settings({
      senderPool: ["a@x.com", "b@x.com"],
      senderCaps: { "b@x.com": 2 },
    });
    const r = choosePooledSender(
      state(),
      { settings: s, identities: ids, blocked: new Set(), load: { "b@x.com": 2 } },
      "a@x.com",
    );
    expect(r.sender).toBeNull();
  });

  it("alternates away from the last account used when it can", () => {
    const s = settings({ senderPool: ["a@x.com", "b@x.com", "c@x.com"] });
    const r = choosePooledSender(
      state({ lastSender: "a@x.com", rotateIndex: 0 }),
      { settings: s, identities: ids, blocked: new Set(), load: {} },
      "",
    );
    expect(["b@x.com", "c@x.com"]).toContain(r.sender);
    expect(r.sender).not.toBe("a@x.com");
  });

  it("a blocked pool account is skipped by the pool pick", () => {
    const s = settings({ senderPool: ["a@x.com", "b@x.com"] });
    const r = choosePooledSender(
      state(),
      { settings: s, identities: ids, blocked: new Set(["a@x.com"]), load: {} },
      "",
    );
    expect(r.sender).toBe("b@x.com");
  });

  it("blocked-Sender items hold as 'sender-blocked' in the plan", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        blockedSenders: ["a@x.com", "b@x.com"],
        openers: [opener(1, { fromEmail: "a@x.com" })],
      }),
    );
    expect(plan.entries[0].hold).toBe("sender-blocked");
  });
});

// --- Claim-predicate helpers (used inside the transactional Claims) ----------

describe("claim eligibility helpers", () => {
  it("senderAllowed: a pinned Sender must itself be free", () => {
    expect(senderAllowed("A@x.com ", new Set(["a@x.com"]), true)).toBe(false);
    expect(senderAllowed("b@x.com", new Set(["a@x.com"]), true)).toBe(true);
  });

  it("senderAllowed: a legacy empty Sender is eligible exactly when any account is free", () => {
    expect(senderAllowed("", new Set(["a@x.com"]), true)).toBe(true);
    expect(senderAllowed("", new Set(["a@x.com"]), false)).toBe(false);
  });

  it("localEligible: unknown timezone falls through to the global window", () => {
    expect(
      localEligible("", settings({ localTimeSend: true }), at(3, 0)),
    ).toBe(true);
  });

  it("localEligible: a fixed-offset contact is gated by their own clock", () => {
    // 10:00 UTC, window 09:00–17:00 local: inside for UTC+00:00, outside
    // (03:00 local) for UTC-07:00.
    const nowUtc = Date.UTC(2026, 7, 20, 10, 0);
    const s = settings({ localTimeSend: true, localStart: "09:00", localEnd: "17:00" });
    expect(localEligible("UTC+00:00", s, nowUtc)).toBe(true);
    expect(localEligible("UTC-07:00", s, nowUtc)).toBe(false);
  });

  it("hasDifferentFreeSender: true only when a DIFFERENT under-cap free account exists", () => {
    const s = settings({
      senderPool: ["a@x.com", "b@x.com"],
      senderCaps: { "b@x.com": 5 },
    });
    const ids = ["a@x.com", "b@x.com"];
    expect(hasDifferentFreeSender(s, ids, "a@x.com", {}, new Set())).toBe(true);
    expect(
      hasDifferentFreeSender(s, ids, "a@x.com", { "b@x.com": 5 }, new Set()),
    ).toBe(false);
    expect(
      hasDifferentFreeSender(s, ids, "a@x.com", {}, new Set(["b@x.com"])),
    ).toBe(false);
  });
});

// --- Plan projection: ordering and ETAs --------------------------------------

describe("plan projection", () => {
  const now = at(10, 0);

  it("orders Openers by id then due Bumps by opener age, one interval apart", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ intervalSec: 60, bumpEnabled: true }),
        openers: [opener(2), opener(5)],
        bumps: [bump(9, daysAgo(4, now)), bump(8, daysAgo(3, now))],
        bumpTemplateCount: 1,
      }),
    );
    expect(plan.entries.map((e) => e.id)).toEqual([2, 5, 9, 8]);
    expect(plan.entries.map((e) => e.etaMs)).toEqual([
      now,
      now + 60_000,
      now + 120_000,
      now + 180_000,
    ]);
    expect(plan.entries[0].hold).toBeNull();
  });

  it("projected slots respect the window end — no ETA past 18:00", () => {
    const nearClose = at(17, 59);
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: nearClose,
        settings: settings({ intervalSec: 60 }),
        openers: [opener(1), opener(2)],
      }),
    );
    expect(plan.entries[0].etaMs).toBe(nearClose);
    // The second slot lands past 18:00 → pushed to tomorrow's window start.
    expect(plan.entries[1].etaMs).toBe(at(9, 0, 21));
  });

  it("a future op_send_after holds as 'not-due' even while the window is shut", () => {
    const sendAfter = new Date(at(9, 0, 27)).toISOString();
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: at(20, 0), // window closed too — not-due is the more specific truth
        openers: [opener(1, { opSendAfter: sendAfter })],
      }),
    );
    expect(plan.entries[0].hold).toBe("not-due");
    expect(plan.entries[0].etaMs).toBeGreaterThanOrEqual(at(9, 0, 27));
  });

  it("the head due item during the drip gap holds as 'drip-gap'", () => {
    const { plan } = computeSendPlan(
      state({ lastSendMs: now - 40_000 }),
      inputs({
        nowMs: now,
        settings: settings({ intervalSec: 60 }),
        openers: [opener(1), opener(2)],
      }),
    );
    expect(plan.entries[0].hold).toBe("drip-gap");
    expect(plan.entries[0].etaMs).toBe(now + 20_000);
    // Queue position alone is not a hold — the second item just has a later ETA.
    expect(plan.entries[1].hold).toBeNull();
  });

  it("a paused queue plans no promises: entries carry neither ETA nor hold", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({ settings: settings({ enabled: false }), openers: [opener(1)] }),
    );
    expect(plan.paused).toBe(true);
    expect(plan.entries[0]).toMatchObject({ etaMs: null, hold: null });
  });

  it("local-time mode holds a contact outside their local window as 'local-window'", () => {
    const nowUtc = Date.UTC(2026, 7, 20, 10, 0);
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: nowUtc,
        settings: settings({ localTimeSend: true, localStart: "09:00", localEnd: "17:00" }),
        openers: [
          opener(1, { timezone: "UTC-07:00" }), // 03:00 local — asleep
          opener(2, { timezone: "UTC+00:00" }), // 10:00 local — awake
        ],
      }),
    );
    expect(plan.entries[0].hold).toBe("local-window");
    expect(plan.entries[1].hold).toBeNull();
  });
});

// --- Post-send bookkeeping ---------------------------------------------------

describe("noteSent", () => {
  it("stamps the send time and the account it left from (lowercased)", () => {
    const now = at(11, 0);
    const next = noteSent(state(), now, "A@x.com");
    expect(next.lastSendMs).toBe(now);
    expect(next.lastSender).toBe("a@x.com");
  });
});

// --- The status-seam payload (.scratch/send-plan ticket 05) ------------------
// planPayload is what the queue status endpoint serves: the worker's cached
// plan reduced to its wire shape, plus the two aggregates the UI used to
// derive itself (next-send anchor, whole-queue finish estimate).

describe("planPayload (status seam)", () => {
  const now = at(10, 0);

  it("carries the plan's entries verbatim, in send order, with its stamp and paused flag", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ intervalSec: 60, bumpEnabled: true }),
        openers: [opener(2), opener(5)],
        bumps: [bump(9, daysAgo(4, now))],
        bumpTemplateCount: 1,
      }),
    );
    const payload = planPayload(plan);
    expect(payload.computedAtMs).toBe(now);
    expect(payload.paused).toBe(false);
    expect(payload.entries).toEqual(plan.entries);
    expect(payload.entries.map((e) => e.id)).toEqual([2, 5, 9]);
  });

  it("Bump entries keep their conditional flag through the payload", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ bumpEnabled: true }),
        bumps: [bump(9, daysAgo(4, now))],
        bumpTemplateCount: 1,
      }),
    );
    const payload = planPayload(plan);
    expect(payload.entries[0]).toMatchObject({ lane: "bump", conditional: true });
  });

  it("nextSendAtMs is the earliest predicted ETA — a not-due head doesn't hide a sooner item", () => {
    // Opener 1 is scheduled for tomorrow; the Claim skips not-due rows, so
    // opener 2 sends first and the anchor must say so.
    const sendAfter = new Date(at(9, 0, 21)).toISOString();
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ intervalSec: 60 }),
        openers: [opener(1, { opSendAfter: sendAfter }), opener(2)],
      }),
    );
    const payload = planPayload(plan);
    // Head entry predicts tomorrow; the anchor is opener 2's slot instead.
    expect(plan.entries[0].etaMs).toBe(at(9, 0, 21));
    expect(payload.nextSendAtMs).toBe(now + 60_000);
  });

  it("finishAtMs is the latest predicted ETA — a not-yet-due Bump's floor holds the queue open", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({
        nowMs: now,
        settings: settings({ intervalSec: 60, bumpEnabled: true, bumpAfterDays: 2 }),
        openers: [opener(1)],
        bumps: [bump(9, daysAgo(1, now))], // due a full day from now
        bumpTemplateCount: 1,
      }),
    );
    const payload = planPayload(plan);
    expect(payload.finishAtMs).toBe(now + 86_400_000);
  });

  it("a paused queue predicts nothing: both aggregates are null", () => {
    const { plan } = computeSendPlan(
      state(),
      inputs({ settings: settings({ enabled: false }), openers: [opener(1)] }),
    );
    const payload = planPayload(plan);
    expect(payload.paused).toBe(true);
    expect(payload.nextSendAtMs).toBeNull();
    expect(payload.finishAtMs).toBeNull();
  });

  it("an empty queue has no entries and no aggregates", () => {
    const { plan } = computeSendPlan(state(), inputs({ nowMs: now }));
    const payload = planPayload(plan);
    expect(payload.entries).toEqual([]);
    expect(payload.nextSendAtMs).toBeNull();
    expect(payload.finishAtMs).toBeNull();
  });
});

// --- Bump template rotation --------------------------------------------------

describe("chooseBumpTemplate", () => {
  it("rotates across the whole library", () => {
    let s = state();
    const bodies = ["one", "two"];
    const picks: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const r = chooseBumpTemplate(s, bodies);
      picks.push(r.body);
      s = r.nextState;
    }
    expect(picks).toEqual(["one", "two", "one"]);
  });

  it("no templates → no Bump, and the rotation stands still", () => {
    const r = chooseBumpTemplate(state({ bumpIndex: 1 }), []);
    expect(r.body).toBeNull();
    expect(r.nextState.bumpIndex).toBe(1);
  });
});
