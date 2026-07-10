"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Best-effort avatar for an email, served through our /api/avatar proxy, which
// resolves the photo via unavatar.io once and caches it on disk. We also
// lazy-load (only request when the element scrolls into view) so long lists
// don't fire a burst of requests. Falls back to `fallback` when there's no
// photo (proxy returns 404 → <img> onError).

// Emails that failed MAX_ATTEMPTS times this session - instant fallback, no
// re-request. Earlier failures retry: the proxy queues upstream fetches to
// dodge unavatar's rate limit, so a photo that 404s on first paint often
// resolves a few seconds later once the queue reaches it.
const failed = new Set<string>();
const attemptsByEmail = new Map<string, number>();
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [8_000, 30_000]; // after 1st failure, after 2nd

export default function GmailAvatar({
  email,
  size = 36,
  className = "",
  fallback,
}: {
  email: string;
  size?: number;
  className?: string;
  fallback: ReactNode;
}) {
  const normalized = (email ?? "").trim().toLowerCase();
  const holderRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [errored, setErrored] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimerRef = useRef<number | null>(null);

  // Reset the error flag when the address changes (e.g. editable Send modal).
  useEffect(() => {
    setErrored(false);
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [normalized]);

  // Load only once the avatar scrolls near the viewport.
  useEffect(() => {
    if (!normalized.includes("@") || visible) return;
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [normalized, visible]);

  const canShow =
    normalized.includes("@") && visible && !errored && !failed.has(normalized);

  if (canShow) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/avatar?email=${encodeURIComponent(normalized)}${
          attempt > 0 ? `&retry=${attempt}` : ""
        }`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => {
          const n = (attemptsByEmail.get(normalized) ?? 0) + 1;
          attemptsByEmail.set(normalized, n);
          setErrored(true);
          if (n >= MAX_ATTEMPTS) {
            failed.add(normalized);
            return;
          }
          const delay =
            RETRY_DELAY_MS[Math.min(n - 1, RETRY_DELAY_MS.length - 1)];
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            setAttempt(n);
            setErrored(false);
          }, delay);
        }}
        className={"shrink-0 object-cover " + (className || "rounded-full")}
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span ref={holderRef} className="inline-flex" style={{ lineHeight: 0 }}>
      {fallback}
    </span>
  );
}
