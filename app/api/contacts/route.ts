import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  deleteContact,
  listContacts,
  upsertContact,
} from "@/lib/contacts-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  markUserActivity();
  return NextResponse.json({ ok: true, contacts: listContacts() });
}

export async function POST(req: Request) {
  markUserActivity();
  let body: {
    key?: string;
    login?: string;
    profileUrl?: string;
    name?: string;
    country?: string;
    emails?: string[];
    phones?: string[];
    telegrams?: string[];
    direct?: boolean;
    attachedUrl?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const key = (body.key ?? "").trim();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "key is required." },
      { status: 400 },
    );
  }

  const clean = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && !!x.trim())
      : [];

  const contact = upsertContact({
    key,
    login: body.login,
    profileUrl: body.profileUrl,
    name: body.name,
    country: body.country,
    emails: clean(body.emails),
    phones: clean(body.phones),
    telegrams: clean(body.telegrams),
    direct: body.direct === true,
    attachedUrl: body.attachedUrl,
  });
  return NextResponse.json({ ok: true, contact });
}

export async function DELETE(req: Request) {
  markUserActivity();
  const key = (new URL(req.url).searchParams.get("key") ?? "").trim();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "key is required." },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: deleteContact(key) });
}
