// The queue UI's rendering of the Send plan (.scratch/send-plan ticket 06).
//
// These test the pure presentation seam only: PlanEntry in → row text/title
// out. The scheduling truth behind the entries is the plan module's business
// (send-plan.test.ts); here we assert the UI repeats it honestly — conditional
// Bump phrasing, Hold reasons from the closed union, no arithmetic of its own.

import { describe, it, expect } from "vitest";
import {
  HOLD_LABEL,
  bumpRowEta,
  fmtClock,
  fmtCountdown,
  fmtFinish,
  openerRowEta,
} from "./queue-plan-view";
import type { PlanEntry } from "@/lib/send-plan";

/** A local wall-clock instant, matching the plan tests' convention. */
const at = (h: number, m: number, day = 20): number =>
  new Date(2026, 7, day, h, m, 0, 0).getTime();

const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({
  id: 1,
  lane: "opener",
  etaMs: at(14, 30),
  hold: null,
  conditional: false,
  ...over,
});

const CLOCK = /\d{1,2}:\d{2}/;

describe("HOLD_LABEL", () => {
  // The Record over the closed HoldReason union is the compile-time gate: a
  // new member fails the typecheck until it gets a phrase. This only guards
  // against an empty phrase slipping through.
  it("gives every Hold reason a non-empty phrase", () => {
    for (const [reason, phrase] of Object.entries(HOLD_LABEL)) {
      expect(phrase.trim(), reason).not.toBe("");
    }
  });
});

describe("openerRowEta", () => {
  it("shows the plan's expected send time as a clock label", () => {
    const row = openerRowEta(entry(), at(10, 0));
    expect(row).not.toBeNull();
    expect(row!.text).toMatch(/sends at/);
    expect(row!.text).toMatch(CLOCK);
  });

  it("carries the Hold reason phrase into the title", () => {
    const row = openerRowEta(entry({ hold: "window" }), at(20, 0));
    expect(row!.title).toContain(HOLD_LABEL.window);
  });

  it("promises nothing while the queue is paused (null ETA)", () => {
    expect(openerRowEta(entry({ etaMs: null }), at(10, 0))).toBeNull();
  });

  it("promises nothing when the plan has no entry for the row", () => {
    expect(openerRowEta(undefined, at(10, 0))).toBeNull();
  });
});

describe("bumpRowEta", () => {
  const args = (over: Partial<Parameters<typeof bumpRowEta>[0]> = {}) => ({
    entry: entry({ lane: "bump" as const, conditional: true }),
    bumpSentAt: null,
    bumpEnabled: true,
    nowMs: at(10, 0),
    ...over,
  });

  it("shows the conditional time — sends at a clock time unless they reply", () => {
    const row = bumpRowEta(args());
    expect(row.text).toMatch(/bump ~.*unless they reply/);
    expect(row.text).toMatch(CLOCK);
  });

  it("states the Pitch outranks queued sends when the contact replies", () => {
    expect(bumpRowEta(args()).title.toLowerCase()).toContain("pitch");
    expect(bumpRowEta(args()).title).toMatch(/outrank/i);
  });

  it("labels an already-bumped row instead of promising a second Bump", () => {
    const row = bumpRowEta(args({ bumpSentAt: "2026-08-19T10:00:00.000Z" }));
    expect(row.text).toContain("bumped");
    expect(row.text).not.toContain("unless");
  });

  it("says Bumps are off when the plan carries no entry and they're disabled", () => {
    const row = bumpRowEta(args({ entry: undefined, bumpEnabled: false }));
    expect(row.text).toBe("pitch on reply");
    expect(row.title).toContain("Bumps are off");
  });

  it("keeps the conditional display for a not-yet-due Bump, with its Hold", () => {
    const row = bumpRowEta(
      args({
        entry: entry({ lane: "bump", conditional: true, hold: "not-due", etaMs: at(9, 0, 22) }),
      }),
    );
    expect(row.text).toMatch(/unless they reply/);
    expect(row.title).toContain(HOLD_LABEL["not-due"]);
  });

  it("promises no time while the queue is paused", () => {
    const row = bumpRowEta(
      args({ entry: entry({ lane: "bump", conditional: true, etaMs: null }) }),
    );
    expect(row.text).toBe("pitch on reply");
    expect(row.title).toMatch(/paused/i);
  });
});

describe("clock formatting", () => {
  it("fmtClock drops the date for a same-day ETA and keeps it across days", () => {
    const sameDay = fmtClock(at(14, 30), at(10, 0));
    const nextDay = fmtClock(at(14, 30, 21), at(10, 0));
    expect(sameDay).toMatch(CLOCK);
    expect(nextDay.length).toBeGreaterThan(sameDay.length);
  });

  it("fmtFinish says 'today' for a same-day finish and names the date otherwise", () => {
    expect(fmtFinish(at(21, 5), at(10, 0))).toMatch(/today$/);
    expect(fmtFinish(at(21, 5, 23), at(10, 0))).not.toMatch(/today$/);
    expect(fmtFinish(at(21, 5, 23), at(10, 0))).toMatch(CLOCK);
  });

  it("fmtCountdown renders minutes and seconds, and 'any moment' at zero", () => {
    expect(fmtCountdown(125)).toBe("2m 05s");
    expect(fmtCountdown(45)).toBe("45s");
    expect(fmtCountdown(0)).toBe("any moment");
  });
});
