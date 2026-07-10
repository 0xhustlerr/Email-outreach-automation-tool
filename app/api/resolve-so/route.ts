import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  findGitHubLoginFromStackOverflow,
  isStackOverflowUrl,
} from "@/lib/stackoverflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  markUserActivity();
  const url = new URL(req.url);
  const input = (url.searchParams.get("url") ?? "").trim();
  if (!input) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  if (!isStackOverflowUrl(input)) {
    return NextResponse.json(
      { error: "Not a Stack Overflow user URL." },
      { status: 400 },
    );
  }

  try {
    const login = await findGitHubLoginFromStackOverflow(input);
    if (!login) {
      return NextResponse.json(
        { error: "No GitHub link found on that Stack Overflow profile." },
        { status: 404 },
      );
    }
    return NextResponse.json({ login });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to fetch Stack Overflow profile.",
      },
      { status: 500 },
    );
  }
}
