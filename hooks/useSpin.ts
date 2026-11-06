"use client";

import { useCallback, useState } from "react";

/**
 * Drives a refresh button's spinning icon: `run(work)` spins until `work`
 * settles AND at least `minMs` has passed, so a reload that answers in 30ms
 * still shows a visible turn instead of a flicker. `run()` with no work just
 * spins for `minMs` (for buttons whose loading state lives elsewhere).
 */
export function useSpin(minMs = 650) {
  const [active, setActive] = useState(0);

  const run = useCallback(
    async <T>(work?: Promise<T> | (() => Promise<T>)): Promise<T | undefined> => {
      setActive((n) => n + 1);
      const started = Date.now();
      try {
        return typeof work === "function" ? await work() : await work;
      } finally {
        const left = minMs - (Date.now() - started);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        setActive((n) => n - 1);
      }
    },
    [minMs],
  );

  return { spinning: active > 0, run };
}
