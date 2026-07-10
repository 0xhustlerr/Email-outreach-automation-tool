import { NextResponse } from "next/server";
import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  GitHubError,
  listUserRepos,
  parseGitHubUsername,
  pickDefaultRepo,
} from "@/lib/github";

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
    const repos = await listUserRepos(user);
    const nonForks = repos.filter((r) => !r.fork);
    const defaultRepo = pickDefaultRepo(repos);
    return NextResponse.json({
      user,
      repos: nonForks,
      defaultRepo: defaultRepo?.name ?? null,
    });
  } catch (err) {
    if (err instanceof GitHubError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "Unexpected error listing repositories." },
      { status: 500 },
    );
  }
}
