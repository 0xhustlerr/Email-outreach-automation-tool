// Seed-inbox provider: the test goes to the other Senders that have Gmail
// reply sync, plus any extra Gmail inboxes added only to receive tests, and we
// read Gmail's labels on each copy.

import { cachedAccessToken, getAccessToken, parseGmailAccounts } from "@/lib/gmail";
import { getGmailClient } from "@/lib/identities-store";
import { listIdentities } from "@/lib/mail";
import { findPlacement } from "./gmail-placement";
import { disabledSeeds, getSeedInbox, listSeedInboxes } from "./store";
import {
  sentAtMs,
  type PlacementProvider,
  type PlacementResultRow,
  type PlacementTestRow,
  type ResultUpdate,
} from "./types";

/** How long a seed copy may take to show up before it counts as Missing. */
export const SEED_MISSING_AFTER_MS = 15 * 60_000;

export type SeedOption = {
  email: string;
  /** 'sender' = a Sender with reply sync; 'extra' = added only for tests. */
  kind: "sender" | "extra";
  /** Checked on the Spam check page: receives tests. */
  enabled: boolean;
};

/** Every inbox that COULD be a seed (other Senders with a Gmail token, then
 *  the extra seed inboxes), with whether it is checked to receive tests. */
export function listSeedOptions(): SeedOption[] {
  const tokens = parseGmailAccounts();
  const off = disabledSeeds();
  const out = new Map<string, SeedOption>();
  for (const id of listIdentities()) {
    const e = id.email.toLowerCase();
    if (tokens[e]) out.set(e, { email: e, kind: "sender", enabled: !off.has(e) });
  }
  for (const s of listSeedInboxes()) {
    if (!out.has(s.email)) out.set(s.email, { email: s.email, kind: "extra", enabled: !off.has(s.email) });
  }
  return [...out.values()];
}

/** The checked seed inboxes a test from `sender` goes to. Never the Sender
 *  itself — mail to yourself skips spam filtering entirely. */
export function seedAddressesFor(sender: string): string[] {
  const self = sender.trim().toLowerCase();
  return listSeedOptions()
    .filter((s) => s.enabled && s.email !== self)
    .map((s) => s.email);
}

/** Access token for a seed: a Sender's reply-sync token, else the seed inbox's
 *  own credentials (its own OAuth client, or the global one). */
export async function seedAccessToken(email: string): Promise<string> {
  const key = email.trim().toLowerCase();
  const asSender = await getAccessToken(key);
  if (asSender) return asSender;
  const seed = getSeedInbox(key);
  if (!seed) throw new Error(`${key} is no longer a seed inbox.`);
  const client =
    seed.clientId && seed.clientSecret
      ? { clientId: seed.clientId, clientSecret: seed.clientSecret }
      : getGmailClient();
  if (!client) throw new Error("No Gmail OAuth client is set for this seed inbox.");
  return cachedAccessToken(key, { ...client, refreshToken: seed.refreshToken });
}

const NO_SEEDS =
  "No seed inboxes to send to. Check one under Seed inboxes, turn on reply sync for another Sender, or add a Gmail seed inbox.";

export const seedsProvider: PlacementProvider = {
  id: "seeds",
  label: "Seed inboxes",
  giveUpAfterMs: SEED_MISSING_AFTER_MS,

  status(sender = "") {
    return seedAddressesFor(sender).length > 0 ? { ok: true } : { ok: false, reason: NO_SEEDS };
  },

  async prepare(sender) {
    const seeds = seedAddressesFor(sender);
    if (seeds.length === 0) throw new Error(NO_SEEDS);
    return {
      seeds: seeds.map((email) => ({ email, provider: "gmail" })),
      mode: "each",
    };
  },

  async collect(test: PlacementTestRow, results: PlacementResultRow[]) {
    const overdue = Date.now() - sentAtMs(test) > SEED_MISSING_AFTER_MS;
    // The fallback search starts when sending STARTED: with several seeds the
    // first copies go out well before sent_at is recorded.
    const searchFromMs = new Date(test.created_at).getTime();
    const updates: ResultUpdate[] = [];

    await Promise.all(
      results
        .filter((r) => r.placement === "pending")
        .map(async (r) => {
          try {
            const access = await seedAccessToken(r.seed);
            const found = await findPlacement(access, {
              messageId: r.message_id,
              from: test.sender,
              subject: test.subject,
              sentAfterMs: searchFromMs,
            });
            if (found) updates.push({ seed: r.seed, ...found });
            else if (overdue) {
              updates.push({
                seed: r.seed,
                placement: "missing",
                detail: "Never arrived within 15 minutes",
              });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : "Could not read this inbox.";
            // Keep retrying until the window closes; then say why it's unknown.
            if (overdue) updates.push({ seed: r.seed, placement: "error", detail: msg });
          }
        }),
    );

    const stillPending = results.filter(
      (r) => r.placement === "pending" && !updates.some((u) => u.seed === r.seed),
    ).length;
    return { updates, finished: stillPending === 0 };
  },
};
