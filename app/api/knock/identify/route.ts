import { Knock } from "@knocklabs/node";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.KNOCK_SECRET_API_KEY?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "Knock is not configured.", user: null },
      { status: 503 },
    );
  }

  let body: { id?: string; name?: string } = {};
  try {
    body = (await req.json()) as { id?: string; name?: string };
  } catch {
    body = {};
  }

  const userId =
    body.id?.trim() ||
    process.env.KNOCK_RECIPIENT_USER_ID?.trim() ||
    "email-finder-user";

  try {
    const knock = new Knock({ apiKey: secret });
    const user = await knock.users.update(userId, {
      name: body.name?.trim() || "Cold Outreach Command Center",
    });
    return NextResponse.json({ error: null, user });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Knock identify failed.";
    return NextResponse.json({ error: message, user: null }, { status: 500 });
  }
}
