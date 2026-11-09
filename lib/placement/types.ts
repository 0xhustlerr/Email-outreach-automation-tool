// Placement tests: where a Sender's outreach actually lands (Inbox, a Gmail
// tab, Spam). Client-safe types only — the page imports these too.

/** Every test provider. Adding one = add its id here and register it in
 *  PROVIDERS (lib/placement/run.ts); everything else reads from those. */
export const PROVIDER_IDS = ["seeds", "glockapps"] as const;
export type PlacementProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(v: unknown): v is PlacementProviderId {
  return (PROVIDER_IDS as readonly unknown[]).includes(v);
}

/** Where one seed's copy of a test landed.
 *  - inbox / tab / spam: found, and where
 *  - other: found, but outside Inbox and Spam (archived by a filter, Trash)
 *  - missing: never arrived within the provider's window
 *  - error: the seed inbox could not be read, so placement is unknown
 *  - send_failed: our SMTP send to this seed failed
 *  - pending: sent, not found yet */
export type Placement =
  | "pending"
  | "inbox"
  | "tab"
  | "spam"
  | "other"
  | "missing"
  | "error"
  | "send_failed";

export type PlacementTestStatus = "sending" | "running" | "done" | "failed";

export type PlacementTestRow = {
  id: string;
  sender: string;
  provider: PlacementProviderId;
  template_id: string;
  subject: string;
  status: PlacementTestStatus;
  external_id: string;
  error: string;
  created_at: string;
  sent_at: string | null;
  finished_at: string | null;
  checked_at: string | null;
};

export type PlacementResultRow = {
  test_id: string;
  seed: string;
  seed_provider: string;
  message_id: string;
  placement: Placement;
  detail: string;
  checked_at: string | null;
};

export type PlacementCounts = Record<Placement, number> & { total: number };

/** What the API returns per test. */
export type PlacementTestView = {
  id: string;
  sender: string;
  provider: PlacementProviderId;
  templateId: string;
  subject: string;
  status: PlacementTestStatus;
  error: string;
  createdAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  counts: PlacementCounts;
  results: {
    seed: string;
    seedProvider: string;
    placement: Placement;
    detail: string;
    checkedAt: string | null;
  }[];
};

/** A provider's answer to "set up a test for this Sender". */
export type PreparedTest = {
  externalId?: string;
  seeds: { email: string; provider: string }[];
  /** 'each' = one message per seed (closest to one-to-one outreach);
   *  'bcc' = one message to the whole seed list (what seed services expect). */
  mode: "each" | "bcc";
  headers?: Record<string, string>;
  /** Text the provider needs in the body to match the message to the test. */
  bodySuffix?: string;
};

export type ResultUpdate = {
  seed: string;
  placement: Placement;
  detail?: string;
  seedProvider?: string;
};

export type ProviderStatus = { ok: true } | { ok: false; reason: string };

export interface PlacementProvider {
  id: PlacementProviderId;
  label: string;
  /** After this long since the send, a test that still can't be resolved is
   *  closed out: anything still waiting is marked unreadable, so a provider
   *  that keeps failing can't leave a test (and the page's polling) running
   *  forever. */
  giveUpAfterMs: number;
  status(sender?: string): ProviderStatus;
  prepare(sender: string): Promise<PreparedTest>;
  /** Read where each pending seed landed. `finished` = nothing left to wait for. */
  collect(
    test: PlacementTestRow,
    results: PlacementResultRow[],
  ): Promise<{ updates: ResultUpdate[]; finished: boolean }>;
  /** Best-effort cleanup when nothing was sent (e.g. refund a paid test). */
  abort?(test: PlacementTestRow): Promise<void>;
}

export const PLACEMENT_LABEL: Record<Placement, string> = {
  pending: "Waiting",
  inbox: "Inbox",
  tab: "Tab",
  spam: "Spam",
  other: "Other folder",
  missing: "Missing",
  error: "Unreadable",
  send_failed: "Send failed",
};

/** When sending finished (the start of every "has it arrived yet" window);
 *  falls back to creation for a test that never recorded it. */
export function sentAtMs(test: Pick<PlacementTestRow, "sent_at" | "created_at">): number {
  return new Date(test.sent_at ?? test.created_at).getTime();
}

export function emptyCounts(): PlacementCounts {
  return {
    pending: 0,
    inbox: 0,
    tab: 0,
    spam: 0,
    other: 0,
    missing: 0,
    error: 0,
    send_failed: 0,
    total: 0,
  };
}
