"use client";

// A Sender's latest Spam check result as one badge (Spam check page and the
// Accounts page).

import { summarizePlacement, type PlacementTone } from "@/lib/placement/summary";
import type { PlacementTestView } from "@/lib/placement/types";

const TONE_BADGE: Record<PlacementTone, string> = {
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
  neutral: "badge-neutral",
};

export default function PlacementSummaryBadge({ test }: { test: PlacementTestView | null }) {
  const s = summarizePlacement(test);
  if (!s) return <span className="badge badge-neutral shrink-0">Not tested</span>;
  return (
    <span title={s.title} className={`badge shrink-0 ${TONE_BADGE[s.tone]}`}>
      {s.label}
    </span>
  );
}
