import { NextResponse } from "next/server";
import { avatarPrefetchStatus } from "@/lib/avatar-prefetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Progress/status of the idle-time avatar prefetcher. Deliberately does NOT
// mark user activity - checking on the prefetcher shouldn't pause it.
export async function GET() {
  return NextResponse.json(avatarPrefetchStatus());
}
