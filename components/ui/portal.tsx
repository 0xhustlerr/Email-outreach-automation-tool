"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const noopSubscribe = () => () => {};

/**
 * Renders children straight into <body>. Full-screen overlays need this: left
 * inside the page, an animated ancestor (`fade-in`/`slide-in`) or the z-40
 * topbar traps them in a lower stacking context — or becomes their containing
 * block — so the header and sidebar paint over the modal.
 */
export function Portal({ children }: { children: ReactNode }) {
  // false during SSR (no document), true on the client — without an effect.
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return isClient ? createPortal(children, document.body) : null;
}
