import { NextResponse } from "next/server";
import {
  fetchAvatarFromUpstream,
  getCachedAvatar,
  isNegativeCached,
  type AvatarImage,
} from "@/lib/avatar-service";
import { markUserActivity } from "@/lib/avatar-prefetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Avatar proxy + cache. Resolution and caching live in lib/avatar-service.ts
// (shared with the idle-time prefetcher); this route just serves HTTP.

function ok(img: AvatarImage): NextResponse {
  return new NextResponse(new Uint8Array(img.buf), {
    headers: {
      "Content-Type": img.contentType,
      "Cache-Control": "public, max-age=604800",
    },
  });
}

export async function GET(req: Request) {
  const email = (new URL(req.url).searchParams.get("email") || "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) {
    return new NextResponse(null, { status: 400 });
  }

  // On-demand avatar requests mean someone is looking at a list - pause the
  // background prefetcher so it never competes with the visible UI.
  markUserActivity();

  const cached = getCachedAvatar(email);
  if (cached) return ok(cached);

  if (isNegativeCached(email)) {
    return new NextResponse(null, { status: 404 });
  }

  const { img } = await fetchAvatarFromUpstream(email);
  if (!img) {
    return new NextResponse(null, { status: 404 });
  }
  return ok(img);
}
