import { NextResponse } from "next/server";
import { isSendingDisabled, listIdentities } from "@/lib/mail";
import { glockAppsPublicSettings } from "@/lib/placement/glockapps";
import {
  PlacementError,
  PROVIDERS,
  refreshRunningTests,
  startPlacementTests,
} from "@/lib/placement/run";
import { listSeedOptions, seedAddressesFor } from "@/lib/placement/seeds";
import { listRecentTests, publicSeedInboxes, toView } from "@/lib/placement/store";
import { isProviderId, type PlacementTestView } from "@/lib/placement/types";
import { listTemplates } from "@/lib/templates-store";

// Placement tests: does each Sender's outreach land in Inbox, a tab, or Spam?
// Unauthenticated like the other local routes; secrets (GlockApps key, seed
// inbox tokens) are never returned.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function snapshot() {
  const bySender = new Map<string, PlacementTestView[]>();
  for (const t of listRecentTests(5)) {
    const list = bySender.get(t.sender) ?? [];
    list.push(toView(t));
    bySender.set(t.sender, list);
  }
  return {
    sendingDisabled: isSendingDisabled(),
    providers: Object.values(PROVIDERS).map((p) => {
      const st = p.status();
      return { id: p.id, label: p.label, configured: st.ok, reason: st.ok ? "" : st.reason };
    }),
    senders: listIdentities().map((i) => {
      const email = i.email.toLowerCase();
      const tests = bySender.get(email) ?? [];
      return {
        email,
        name: i.name,
        seeds: seedAddressesFor(email),
        latest: tests[0] ?? null,
        history: tests,
      };
    }),
    seedInboxes: publicSeedInboxes(),
    seedOptions: listSeedOptions(),
    glockapps: glockAppsPublicSettings(),
    templates: listTemplates("opener").map((t) => ({ id: t.id, label: t.label })),
  };
}

/** Everything the Spam check page shows, after collecting fresh results for
 *  running tests. `?refresh=0` skips the collecting (the Accounts page badge
 *  only needs what is already stored). */
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("refresh") !== "0") await refreshRunningTests();
  return NextResponse.json({ ok: true, ...snapshot() });
}

/** Start tests. Body: { senders: string[], provider, templateId }. */
export async function POST(req: Request) {
  let body: { senders?: unknown; provider?: unknown; templateId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (!isProviderId(body.provider)) {
    return NextResponse.json({ ok: false, error: "Unknown test provider." }, { status: 400 });
  }
  const senders = Array.isArray(body.senders) ? body.senders.map(String) : [];
  try {
    const tests = startPlacementTests({
      senders,
      provider: body.provider,
      templateId: String(body.templateId ?? ""),
    });
    return NextResponse.json({ ok: true, tests, ...snapshot() });
  } catch (e) {
    const status = e instanceof PlacementError ? e.status : 500;
    const error = e instanceof Error ? e.message : "Could not start the test.";
    return NextResponse.json({ ok: false, error }, { status });
  }
}
