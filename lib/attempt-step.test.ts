// The attempt step's outcome policy, asserted ONCE for all three Lanes
// (.scratch/send-plan ticket 04). The seam is the adapter: an in-memory fake
// here, the SQLite-backed ones in the queue worker. Each case is a wire
// result in → adapter effects + step outcome out; nothing reaches the
// database, the network, or the worker's shell.

import { describe, it, expect } from "vitest";
import { applyAttemptOutcome, type LaneAdapter } from "./attempt-step";
import type { SendResult } from "./send-core";

/** In-memory adapter that records every effect the step applies. */
function fakeAdapter() {
  const calls: string[] = [];
  const adapter: LaneAdapter = {
    revert: () => calls.push("revert"),
    markSent: (messageId, sender) => calls.push(`markSent ${messageId} ${sender}`),
    markFailed: (error) => calls.push(`markFailed ${error}`),
  };
  return { adapter, calls };
}

describe("applyAttemptOutcome", () => {
  it("transient failure reverts the item and burns no attempt (offline)", () => {
    const { adapter, calls } = fakeAdapter();
    const result: SendResult = {
      ok: false,
      error: "connect ETIMEDOUT",
      status: 502,
      transient: true,
    };
    const step = applyAttemptOutcome(result, adapter);
    expect(step).toEqual({ outcome: "offline", error: "connect ETIMEDOUT" });
    expect(calls).toEqual(["revert"]);
  });

  it("success marks the item sent with the wire message id and sender", () => {
    const { adapter, calls } = fakeAdapter();
    const result: SendResult = { ok: true, messageId: "<m1@x>", sender: "a@x.com" };
    const step = applyAttemptOutcome(result, adapter);
    expect(step).toEqual({
      outcome: "attempted",
      disposition: "sent",
      sender: "a@x.com",
    });
    expect(calls).toEqual(["markSent <m1@x> a@x.com"]);
  });

  it("policy block reverts the item as an account fault, not a strike", () => {
    const { adapter, calls } = fakeAdapter();
    const result: SendResult = {
      ok: false,
      error: "550-5.7.1 unsolicited mail",
      status: 502,
      blockKind: "policy",
    };
    const step = applyAttemptOutcome(result, adapter);
    expect(step).toEqual({
      outcome: "attempted",
      disposition: "sender-blocked",
      error: "550-5.7.1 unsolicited mail",
    });
    expect(calls).toEqual(["revert"]);
  });

  it("any other failure counts an attempt toward permanent failure", () => {
    const { adapter, calls } = fakeAdapter();
    const result: SendResult = {
      ok: false,
      error: "550 no such user",
      status: 502,
      blockKind: "invalid",
    };
    const step = applyAttemptOutcome(result, adapter);
    expect(step).toEqual({
      outcome: "attempted",
      disposition: "failed",
      error: "550 no such user",
    });
    expect(calls).toEqual(["markFailed 550 no such user"]);
  });

  it("transient wins over a bounce classification — nothing left the machine", () => {
    const { adapter, calls } = fakeAdapter();
    const result: SendResult = {
      ok: false,
      error: "socket hang up",
      status: 502,
      transient: true,
      blockKind: "policy",
    };
    const step = applyAttemptOutcome(result, adapter);
    expect(step.outcome).toBe("offline");
    expect(calls).toEqual(["revert"]);
  });
});
