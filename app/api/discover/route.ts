import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import { discoverEmails } from "@/lib/discover";
import { GitHubError, parseGitHubUsername } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  markUserActivity();
  const url = new URL(req.url);
  const raw = url.searchParams.get("user") ?? "";
  const user = parseGitHubUsername(raw);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid GitHub username or profile URL." },
      { status: 400 },
    );
  }

  try {
    const result = await discoverEmails(user);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GitHubError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Discovery failed." },
      { status: 500 },
    );
  }
}
