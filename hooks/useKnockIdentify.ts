"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "email-finder-knock-user-id";
const DEFAULT_NAME = "Cold Outreach Command Center";

export function useKnockIdentify(enabled: boolean) {
  const [userId, setUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setUserId(null);
      setReady(false);
      return;
    }

    let cancelled = false;

    (async () => {
      const stored = localStorage.getItem(STORAGE_KEY)?.trim();
      try {
        const res = await fetch("/api/knock/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: stored || undefined,
            name: DEFAULT_NAME,
          }),
        });
        const data = (await res.json()) as {
          user?: { id?: string };
          error?: string;
        };
        if (cancelled) return;
        const id = data.user?.id ?? stored ?? null;
        if (id) {
          localStorage.setItem(STORAGE_KEY, id);
          setUserId(id);
        }
      } catch {
        if (stored) setUserId(stored);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { userId, ready };
}
