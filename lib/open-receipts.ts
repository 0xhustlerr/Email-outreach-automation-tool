// Attaches open-tracking "seen" receipts to the OUTBOUND messages of a Gmail
// conversation. Each outbound message is matched to the nearest logged send to
// that contact (send_log time ≈ Gmail internalDate within seconds); every send
// is consumed at most once so two messages can't claim the same open. Applied at
// RESPONSE time (not cache time) so opens that arrive after a thread was cached
// still surface on the next poll.

import type { GmailThreadMessage } from "./gmail";
import { getContactSends } from "./db";

const MATCH_TOLERANCE_MS = 5 * 60 * 1000;

export function attachOpenReceipts(
  messages: GmailThreadMessage[],
  contact: string,
): void {
  const sends = getContactSends(contact);
  if (sends.length === 0) return;
  const used = new Array(sends.length).fill(false);
  for (const m of messages) {
    if (!m.isOutbound) continue;
    const at = m.receivedMs || Date.parse(m.receivedAt) || 0;
    if (!at) continue;
    let best = -1;
    let bestDiff = MATCH_TOLERANCE_MS;
    for (let i = 0; i < sends.length; i++) {
      if (used[i]) continue;
      const diff = Math.abs(sends[i].sentMs - at);
      if (diff <= bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    if (best >= 0) {
      used[best] = true;
      m.openedAt = sends[best].openedAt;
      m.openCount = sends[best].openCount;
    }
  }
}
