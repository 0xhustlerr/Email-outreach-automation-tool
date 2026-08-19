"use client";

// The match score badge shared by the two places an address gets scored: the
// CSV import's result rows and the profile-search contact cards. Both read the
// same 0-100 number out of lib/email-score.ts, so the colour tiers - the user's
// shorthand for "safe to send" - are defined once, here.
//
// The two screens don't feed the scorer identical evidence (the profile search
// can't measure commit share - see the `emailScores` memo in app/page.tsx), so
// the same person can land a few points apart on the two screens. The tooltip
// carries the breakdown that explains the gap.

// Size is a variant, not a caller-supplied class: two paddings on one element
// would both survive into the class attribute and let stylesheet order decide.
const SIZE: Record<"sm" | "md", string> = {
  sm: "px-1 py-px text-[10px]",
  md: "px-1.5 py-0.5 text-[11px]",
};

function toneFor(score: number): string {
  return score >= 70
    ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
    : score >= 50
      ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
      : "border-amber-400/40 bg-amber-500/10 text-amber-200";
}

export default function EmailScoreBadge({
  score,
  reasons,
  size = "sm",
}: {
  score: number;
  /** Score breakdown from the scorer, surfaced as a hover tooltip. */
  reasons?: string[];
  size?: "sm" | "md";
}) {
  const title =
    reasons && reasons.length > 0
      ? `Match score ${score}/100 — ${reasons.join(", ")}`
      : `Match score ${score}/100`;
  return (
    <span
      title={title}
      className={`shrink-0 rounded border font-semibold tabular-nums ${SIZE[size]} ${toneFor(score)}`}
    >
      {score}
    </span>
  );
}
