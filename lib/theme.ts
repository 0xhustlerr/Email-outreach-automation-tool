// Shared by the server layout (pre-paint script) and the client theme hook.
// Kept out of the "use client" hook module: a server component importing a
// constant from a client module gets a client reference, not the value.

export type Theme = "light" | "dark";

/** localStorage key holding the user's chosen theme. */
export const THEME_STORAGE_KEY = "theme";

/**
 * Runs in <head> before first paint (inlined by app/layout.tsx), so the page
 * never flashes the wrong theme. Saved choice wins; otherwise follow the OS.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})();`;
