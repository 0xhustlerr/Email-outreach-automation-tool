import { NextResponse } from "next/server";
import {
  clearGlockAppsSettings,
  getGlockAppsSettings,
  setGlockAppsSettings,
} from "@/lib/identities-store";
import { glockAppsPublicSettings, listGlockAppsProjects } from "@/lib/placement/glockapps";

// GlockApps settings. The API key is write-only: it is validated on save and
// never sent back.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function keyFrom(body: { apiKey?: string }): string {
  return (body.apiKey ?? "").trim() || getGlockAppsSettings()?.apiKey || "";
}

/** List projects for a key (to pick one). Body: { apiKey? } — omitted = the saved key. */
export async function POST(req: Request) {
  let body: { apiKey?: string } = {};
  try {
    body = await req.json();
  } catch {
    // use the saved key
  }
  const apiKey = keyFrom(body);
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Paste your GlockApps API key." }, { status: 400 });
  }
  try {
    const projects = await listGlockAppsProjects(apiKey);
    return NextResponse.json({ ok: true, projects });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not reach GlockApps." },
      { status: 400 },
    );
  }
}

/** Save. Body: { apiKey?, projectId, providerGroupIds? } — apiKey omitted keeps the saved one. */
export async function PUT(req: Request) {
  let body: { apiKey?: string; projectId?: string; providerGroupIds?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const apiKey = keyFrom(body);
  const projectId = String(body.projectId ?? "").trim();
  const providerGroupIds = (Array.isArray(body.providerGroupIds) ? body.providerGroupIds : [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  const badGroup = providerGroupIds.find((v) => !/^\d+$/.test(v));
  if (badGroup) {
    return NextResponse.json(
      { ok: false, error: `"${badGroup}" isn't a GlockApps provider group ID (they are numbers).` },
      { status: 400 },
    );
  }
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Paste your GlockApps API key." }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Pick a GlockApps project." }, { status: 400 });
  }
  try {
    const projects = await listGlockAppsProjects(apiKey);
    // Only enforce the project when the list could be parsed at all.
    if (projects.length > 0 && !projects.some((p) => p.id === projectId)) {
      return NextResponse.json(
        { ok: false, error: `Project ${projectId} isn't in this GlockApps account.` },
        { status: 400 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not reach GlockApps." },
      { status: 400 },
    );
  }
  setGlockAppsSettings({ apiKey, projectId, providerGroupIds });
  return NextResponse.json({ ok: true, glockapps: glockAppsPublicSettings() });
}

export async function DELETE() {
  clearGlockAppsSettings();
  return NextResponse.json({ ok: true, glockapps: glockAppsPublicSettings() });
}
