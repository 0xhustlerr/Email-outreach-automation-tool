// One-line verdict for a placement test — shared by the Spam check page and
// the badge on the Accounts page. Pure and client-safe.

import type { PlacementTestView } from "./types";

export type PlacementTone = "success" | "warning" | "danger" | "info" | "neutral";

export function summarizePlacement(test: PlacementTestView | null): {
  tone: PlacementTone;
  label: string;
  title: string;
} | null {
  if (!test) return null;
  if (test.status === "sending") {
    return { tone: "info", label: "Sending test…", title: "Sending the placement test." };
  }
  if (test.status === "failed") {
    return { tone: "neutral", label: "Test failed", title: test.error || "The placement test failed." };
  }
  const c = test.counts;
  // Seeds we never reached say nothing about placement.
  const total = c.total - c.send_failed - c.error;
  const when = new Date(test.finishedAt ?? test.sentAt ?? test.createdAt).toLocaleString();
  const breakdown =
    `Inbox ${c.inbox}, tabs ${c.tab}, spam ${c.spam}, other ${c.other}, missing ${c.missing}` +
    (c.pending ? `, waiting ${c.pending}` : "");
  const title = `${breakdown} (${when}).`;

  if (total <= 0) {
    return { tone: "neutral", label: "No result", title: test.error || "No seed could be checked." };
  }
  if (c.spam > 0) return { tone: "danger", label: `Spam ${c.spam}/${total}`, title };
  if (test.status === "running") {
    return { tone: "info", label: `Checking ${total - c.pending}/${total}`, title };
  }
  if (c.missing > 0) return { tone: "warning", label: `Missing ${c.missing}/${total}`, title };
  if (c.tab > 0 || c.other > 0) {
    return { tone: "warning", label: `Inbox ${c.inbox}/${total}`, title };
  }
  return { tone: "success", label: `Inbox ${c.inbox}/${total}`, title };
}
