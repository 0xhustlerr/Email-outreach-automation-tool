// Running placement tests. Starting one validates up front (so the API can
// answer with a clear error), then sends in the background, one test at a
// time; results are collected lazily when the tests are read (the page polls
// while any test is running). There is deliberately no background loop —
// ADR-0002.
//
// Test sends call sendMail directly, never performSend: they are not outreach
// and must not reach send_log, the emailed-once rule, or Insights (ADR-0004).

import { db } from "@/lib/db";
import { isSendingDisabled, listIdentities, sendMail } from "@/lib/mail";
import { listTemplates } from "@/lib/templates-store";
import { displayName, senderVars, substitute, urlVars } from "@/lib/template-vars";
import { glockAppsProvider } from "./glockapps";
import { seedsProvider } from "./seeds";
import {
  applyUpdates,
  createTest,
  finishTest,
  getTest,
  insertResults,
  listResults,
  listTestsByStatus,
  markSent,
  toView,
  updateTest,
} from "./store";
import {
  sentAtMs,
  type PlacementProvider,
  type PlacementProviderId,
  type PlacementTestRow,
  type PlacementTestView,
} from "./types";

export const PROVIDERS: Record<PlacementProviderId, PlacementProvider> = {
  seeds: seedsProvider,
  glockapps: glockAppsProvider,
};

/** Don't hit Gmail / GlockApps more often than this per test. */
const REFRESH_MIN_MS = 20_000;

/** Contact placeholders filled from the most recent real send, so links and
 *  names in the test look like the outreach they stand in for (spam filters
 *  read links). Falls back to neutral values before anything was sent. */
function sampleContactVars(): Record<string, string> {
  let row: { name: string; link: string; username: string } | undefined;
  try {
    row = db
      .prepare(
        `SELECT name, link, username FROM send_log
         WHERE deleted = 0 AND mail_sent = 1 ORDER BY id DESC LIMIT 1`,
      )
      .get() as typeof row;
  } catch {
    // no history yet
  }
  return {
    ...urlVars({ upwork: row?.link ?? "", username: row?.username ?? "" }),
    name: displayName(row?.name ?? ""),
  };
}

/** The Opener as a prospect would get it: contact placeholders filled from a
 *  real recent contact, sender placeholders left for the mailer. */
export function renderTestEmail(t: { subject: string; body: string }): {
  subject: string;
  body: string;
} {
  const vars = { ...sampleContactVars(), ...senderVars() };
  return {
    subject: substitute(t.subject, vars).trim(),
    body: substitute(t.body, vars),
  };
}

export class PlacementError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// Every test send in this process runs through one queue: Senders are tested
// one after another, never in parallel. `queued` is what tells a live test
// still "sending" apart from one a restart cut off.
const globalForSends = globalThis as unknown as {
  __placementSends?: { chain: Promise<void>; queued: Set<string> };
};
const sends = (globalForSends.__placementSends ??= {
  chain: Promise.resolve(),
  queued: new Set<string>(),
});

/** Start one test per sender. Throws PlacementError for anything the user
 *  must fix first; sending itself happens in the background. */
export function startPlacementTests(input: {
  senders: string[];
  provider: PlacementProviderId;
  templateId: string;
}): PlacementTestView[] {
  if (isSendingDisabled()) {
    throw new PlacementError(
      "Sending is disabled on this server (NEXT_PUBLIC_SEND_DISABLED=1), so no test was sent.",
      409,
    );
  }
  const provider = PROVIDERS[input.provider];
  const template = listTemplates("opener").find((t) => t.id === input.templateId);
  if (!template) throw new PlacementError("Pick an Opener template for the test.");

  const identities = listIdentities();
  const senders = [...new Set(input.senders.map((s) => s.trim().toLowerCase()))];
  if (senders.length === 0) throw new PlacementError("Pick at least one Sender.");
  const identity = (s: string) => identities.find((i) => i.email.toLowerCase() === s);
  for (const s of senders) {
    if (!identity(s)) throw new PlacementError(`${s} is not a connected Sender.`);
    const st = provider.status(s);
    if (!st.ok) throw new PlacementError(st.reason);
  }

  const email = renderTestEmail(template);
  if (!email.subject || !email.body.trim()) {
    throw new PlacementError("That template has an empty subject or body.");
  }

  return senders.map((s) => {
    const test = createTest({
      sender: s,
      provider: provider.id,
      templateId: template.id,
      subject: email.subject,
    });
    const from = { email: identity(s)!.email, name: identity(s)!.name };
    sends.queued.add(test.id);
    sends.chain = sends.chain
      .then(() => sendTest(test, provider, { ...email, from }))
      .catch((e) => {
        // Anything the send itself didn't handle (a DB error, say) still
        // closes the test out instead of leaving it "sending".
        finishTest(test.id, "failed", e instanceof Error ? e.message : "The test could not be sent.");
      })
      .finally(() => sends.queued.delete(test.id));
    return toView(test, []);
  });
}

async function sendTest(
  test: PlacementTestRow,
  provider: PlacementProvider,
  email: { subject: string; body: string; from: { email: string; name: string } },
): Promise<void> {
  let prepared;
  try {
    prepared = await provider.prepare(test.sender);
  } catch (e) {
    finishTest(test.id, "failed", e instanceof Error ? e.message : "Could not set up the test.");
    return;
  }
  if (prepared.externalId) {
    updateTest(test.id, { external_id: prepared.externalId });
    test = { ...test, external_id: prepared.externalId };
  }
  insertResults(
    test.id,
    prepared.seeds.map((s) => ({
      seed: s.email,
      seedProvider: s.provider,
      messageId: "",
      placement: "pending" as const,
    })),
  );

  // The provider's tag goes in the body, before the Signature the mailer
  // appends — a seed service only needs it somewhere in the text.
  const body = prepared.bodySuffix ? `${email.body.trimEnd()}\n\n${prepared.bodySuffix}` : email.body;
  const base = {
    from: email.from,
    subject: email.subject,
    body,
    headers: prepared.headers,
  };
  const outcomes: { seed: string; seedProvider: string; messageId: string; error?: string }[] = [];

  if (prepared.mode === "bcc") {
    const [first, ...rest] = prepared.seeds;
    try {
      const { messageId } = await sendMail({ ...base, to: first.email, bcc: rest.map((r) => r.email) });
      for (const s of prepared.seeds) outcomes.push({ seed: s.email, seedProvider: s.provider, messageId });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Send failed.";
      for (const s of prepared.seeds) outcomes.push({ seed: s.email, seedProvider: s.provider, messageId: "", error });
    }
  } else {
    for (const s of prepared.seeds) {
      try {
        const { messageId } = await sendMail({ ...base, to: s.email });
        outcomes.push({ seed: s.email, seedProvider: s.provider, messageId });
      } catch (e) {
        outcomes.push({
          seed: s.email,
          seedProvider: s.provider,
          messageId: "",
          error: e instanceof Error ? e.message : "Send failed.",
        });
      }
    }
  }

  insertResults(
    test.id,
    outcomes.map((o) => ({
      seed: o.seed,
      seedProvider: o.seedProvider,
      messageId: o.messageId,
      placement: o.error ? ("send_failed" as const) : ("pending" as const),
      detail: o.error,
    })),
  );

  const failures = outcomes.filter((o) => o.error);
  if (failures.length === outcomes.length) {
    finishTest(test.id, "failed", failures[0]?.error ?? "Every test send failed.");
    await provider.abort?.(test);
    return;
  }
  markSent(test.id);
}

// --- collecting results ---------------------------------------------------------

const globalForRefresh = globalThis as unknown as {
  __placementRefresh?: Map<string, Promise<void>>;
};
const inFlight = (globalForRefresh.__placementRefresh ??= new Map());

/** Collect results for one running test (throttled to once per
 *  REFRESH_MIN_MS; concurrent callers share one in-flight collection). */
export async function refreshPlacementTest(id: string): Promise<void> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const test = getTest(id);
  if (!test) return;

  if (test.status === "sending") {
    // Not in this process's send queue = the app restarted mid-send.
    if (!sends.queued.has(id)) {
      finishTest(id, "failed", "The app stopped before this test finished sending.");
    }
    return;
  }
  if (test.status !== "running") return;
  if (test.checked_at && Date.now() - new Date(test.checked_at).getTime() < REFRESH_MIN_MS) {
    return;
  }

  const run = (async () => {
    const provider = PROVIDERS[test.provider];
    try {
      const { updates, finished } = await provider.collect(test, listResults(id));
      applyUpdates(id, updates);
      updateTest(id, { checked_at: new Date().toISOString(), error: "" });
      if (finished) finishTest(id, "done");
    } catch (e) {
      const error = e instanceof Error ? e.message : "Could not check results.";
      if (Date.now() - sentAtMs(test) > provider.giveUpAfterMs) {
        // Still failing past the window: close it out rather than poll forever.
        applyUpdates(
          id,
          listResults(id)
            .filter((r) => r.placement === "pending")
            .map((r) => ({ seed: r.seed, placement: "error" as const, detail: error })),
        );
        finishTest(id, "done", error);
      } else {
        updateTest(id, { checked_at: new Date().toISOString(), error });
      }
    }
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  return run;
}

/** Collect for every test that is still waiting, but never hold the caller
 *  longer than `maxWaitMs`: a slow provider finishes in the background and
 *  shows up on the next read. */
export async function refreshRunningTests(maxWaitMs = 5_000): Promise<void> {
  const ids = [...listTestsByStatus("sending"), ...listTestsByStatus("running")].map((t) => t.id);
  if (ids.length === 0) return;
  const all = Promise.all(ids.map((id) => refreshPlacementTest(id)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  clearTimeout(timer);
}
