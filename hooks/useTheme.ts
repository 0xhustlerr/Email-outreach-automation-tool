"use client";

import { useCallback, useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

export type { Theme };

const CHANGE_EVENT = "theme-change";

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  // Another tab changed the theme: follow it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY && (e.newValue === "light" || e.newValue === "dark")) {
      applyTheme(e.newValue);
    }
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Current theme (from <html data-theme>) and a toggle that remembers the choice. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark" as const);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // storage blocked — the choice lasts for this session only
    }
    applyTheme(next);
  }, []);

  const toggleTheme = useCallback(() => setTheme(readTheme() === "light" ? "dark" : "light"), [setTheme]);

  return { theme, setTheme, toggleTheme };
}
