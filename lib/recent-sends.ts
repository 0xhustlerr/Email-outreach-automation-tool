// In-memory ring buffer of recent sends, so the UI can pop a "just sent"
// notification for each email as it goes out (queue drip + follow-ups + manual
// sends). Not persisted — it only needs to cover the last few minutes.

export type SendEventKind = "opener" | "followup" | "single";

export type SendEvent = {
  id: number;
  email: string;
  kind: SendEventKind;
  sender: string;
  at: string; // ISO
};

type Buffer = { seq: number; events: SendEvent[] };
const globalForSends = globalThis as unknown as { __recentSends?: Buffer };
const buf: Buffer = globalForSends.__recentSends ?? { seq: 0, events: [] };
globalForSends.__recentSends = buf;

const MAX = 100;

export function recordSendEvent(
  email: string,
  kind: SendEventKind,
  sender: string,
): void {
  buf.seq += 1;
  buf.events.unshift({
    id: buf.seq,
    email: email.trim().toLowerCase(),
    kind,
    sender,
    at: new Date().toISOString(),
  });
  if (buf.events.length > MAX) buf.events.length = MAX;
}

/** Events newer than `afterId` (0 = all buffered), oldest-first for display. */
export function recentSendsAfter(afterId: number): {
  latestId: number;
  events: SendEvent[];
} {
  const events = buf.events.filter((e) => e.id > afterId).reverse();
  return { latestId: buf.seq, events };
}
