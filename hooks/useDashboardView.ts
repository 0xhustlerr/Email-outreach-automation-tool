"use client";

import { useCallback, useSyncExternalStore } from "react";

export const DASHBOARD_VIEWS = [
  "scanner",
  "insights",
  "history",
  "contacts",
  "queue",
  "import",
  "templates",
  "accounts",
  "placement",
  "integrations",
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

const CHANGE_EVENT = "dashboard-view-change";

// Old links keep working after a page is renamed.
const LEGACY: Record<string, DashboardView> = { github: "integrations" };

function readView(): DashboardView {
  const raw = new URLSearchParams(window.location.search).get("view");
  const v = raw && LEGACY[raw] ? LEGACY[raw] : raw;
  return (DASHBOARD_VIEWS as readonly string[]).includes(v ?? "")
    ? (v as DashboardView)
    : "scanner";
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * The page shown in the dashboard's main area, kept in the URL as `?view=…`
 * so back/forward and refresh land on the same page. Switching views is a
 * history push, not a route change, so the scanner's in-memory state (scan
 * results, activity log) survives a visit to another page.
 */
export function useDashboardView() {
  const view = useSyncExternalStore(subscribe, readView, () => "scanner" as const);

  const navigate = useCallback((next: DashboardView) => {
    if (readView() === next) return;
    const url = new URL(window.location.href);
    if (next === "scanner") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.pushState(null, "", url);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [view, navigate] as const;
}
