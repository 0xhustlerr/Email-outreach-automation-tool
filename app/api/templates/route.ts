import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  deleteTemplate,
  listTemplates,
  saveTemplate,
  type TemplateKind,
} from "@/lib/templates-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  markUserActivity();
  return NextResponse.json({ ok: true, templates: listTemplates() });
}

export async function POST(req: Request) {
  markUserActivity();
  let body: {
    id?: string;
    label?: string;
    subject?: string;
    body?: string;
    kind?: TemplateKind;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const label = (body.label ?? "").trim();
  const subject = body.subject ?? "";
  const templateBody = body.body ?? "";
  if (!label) {
    return NextResponse.json(
      { ok: false, error: "Template name is required." },
      { status: 400 },
    );
  }
  if (!subject.trim() || !templateBody.trim()) {
    return NextResponse.json(
      { ok: false, error: "Subject and body are required." },
      { status: 400 },
    );
  }

  const saved = saveTemplate({
    id: body.id?.trim() || undefined,
    label,
    subject,
    body: templateBody,
    kind: body.kind === "followup" ? "followup" : "opener",
  });
  return NextResponse.json({ ok: true, template: saved });
}

export async function DELETE(req: Request) {
  markUserActivity();
  const id = (new URL(req.url).searchParams.get("id") ?? "").trim();
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "id is required." },
      { status: 400 },
    );
  }
  const res = deleteTemplate(id);
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: res.error },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
