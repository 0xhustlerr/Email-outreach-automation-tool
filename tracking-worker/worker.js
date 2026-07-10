// Cloudflare Worker — email open-tracking pixel + opens API.
//
// One tiny shared service used by every Cold Outreach Command Center install.
// It never sees recipient emails or message content — only opaque tokens the
// local app generates. Data model (Workers KV, binding `OPENS`):
//   key      = "t:<installId>-<random>"
//   metadata = { c: openCount, f: firstOpenMs, l: lastOpenMs }
//
// Routes:
//   GET /o/<token>.gif          -> record an open, return a 1x1 transparent GIF
//   GET /opens?ik=<installId>   -> list this install's opens (for the app to poll)
//   GET /health                 -> { ok: true }

// 1x1 transparent GIF.
const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Tracking pixel.
    if (path.startsWith("/o/")) {
      const token = decodeURIComponent(path.slice(3)).replace(/\.gif$/i, "");
      if (token && env.OPENS) {
        try {
          await recordOpen(env, token);
        } catch {
          // never fail the pixel — always return the image
        }
      }
      return pixelResponse();
    }

    // Opens API — the local app polls this with its install id.
    if (path === "/opens") {
      const ik = (url.searchParams.get("ik") || "").trim();
      if (ik.length < 8) return json({ ok: false, error: "ik required" }, 400);
      const since = Number(url.searchParams.get("since") || 0);
      const list = await env.OPENS.list({ prefix: `t:${ik}-`, limit: 1000 });
      const opens = [];
      for (const k of list.keys) {
        const m = k.metadata || {};
        if (since && (m.l || 0) < since) continue;
        opens.push({ token: k.name.slice(2), count: m.c || 0, first: m.f || 0, last: m.l || 0 });
      }
      return json({ ok: true, opens });
    }

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "open-tracking" });
    }
    return new Response("Not found", { status: 404 });
  },
};

async function recordOpen(env, token) {
  const key = `t:${token}`;
  const now = Date.now();
  let meta = { c: 0, f: now, l: now };
  const existing = await env.OPENS.getWithMetadata(key);
  if (existing && existing.metadata) meta = existing.metadata;
  meta.c = (meta.c || 0) + 1;
  meta.f = meta.f || now;
  meta.l = now;
  // 120-day TTL so storage never grows unbounded.
  await env.OPENS.put(key, "1", { metadata: meta, expirationTtl: 60 * 60 * 24 * 120 });
}

function pixelResponse() {
  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
