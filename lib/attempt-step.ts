// The send-outcome policy of the attempt step — implemented exactly ONCE for
// all three Lanes (Pitch, Opener, Bump). The queue worker used to carry a
// copy of this ritual per lane, with the obligations living in comments; here
// they are the behaviour:
//
//   transient  → the send never reached Gmail, so the contact is blameless:
//                put the item back untouched and burn NO attempt. Three
//                connection drops must never mark three prospects permanently
//                failed for a fault that was entirely our end.
//   policy     → Gmail blocked the ACCOUNT, not this contact: put the item
//                back instead of counting a strike. Without the revert, the
//                same head-of-queue contact would be re-claimed and killed
//                after max attempts, then the next, for as long as the
//                Sender block lasts.
//   success    → mark and stamp through the adapter.
//   otherwise  → a real per-contact failure: count the attempt toward the
//                permanent 'failed' state.
//
// Lane-specific effects go through the LaneAdapter seam: SQLite-backed
// adapters in the queue worker, an in-memory fake in the tests. The step
// itself touches nothing but the adapter — no database, network, or timers.

import type { SendResult } from "./send-core";

// What a lane did with the item it claimed, so the loop knows how long to wait:
//   "attempted" — an email actually went down the wire (drip spacing applies)
//   "held"      — nothing was sent, item put back (short tick)
//   "offline"   — the link is down, item put back (offline backoff)
export type LaneOutcome = "attempted" | "held" | "offline";

/** The per-lane effects the attempt step drives. */
export type LaneAdapter = {
  /** Put the claimed item back exactly as it was — no attempt burned. */
  revert(): void;
  /** Stamp the item sent with what actually went down the wire. */
  markSent(messageId: string, sender: string): void;
  /** Count one attempt toward the permanent 'failed' state. */
  markFailed(error: string): void;
};

/** The step's verdict; the worker shell maps it onto logs, backoff and RAM.
 *  (The wire message id isn't carried — the adapter already stamped it.) */
export type AttemptStep =
  | { outcome: "offline"; error: string }
  | { outcome: "attempted"; disposition: "sent"; sender: string }
  | { outcome: "attempted"; disposition: "sender-blocked"; error: string }
  | { outcome: "attempted"; disposition: "failed"; error: string };

export function applyAttemptOutcome(
  result: SendResult,
  adapter: LaneAdapter,
): AttemptStep {
  if (!result.ok && result.transient) {
    adapter.revert();
    return { outcome: "offline", error: result.error };
  }
  if (result.ok) {
    adapter.markSent(result.messageId, result.sender);
    return { outcome: "attempted", disposition: "sent", sender: result.sender };
  }
  if (result.blockKind === "policy") {
    adapter.revert();
    return { outcome: "attempted", disposition: "sender-blocked", error: result.error };
  }
  adapter.markFailed(result.error);
  return { outcome: "attempted", disposition: "failed", error: result.error };
}
