import type { Config } from "tailwindcss";
import palette from "tailwindcss/colors";
import plugin from "tailwindcss/plugin";

// Light/dark theming without `dark:` variants.
//
// Every palette colour is a CSS variable (`--c-<family>-<shade>`, as "r g b"
// so opacity modifiers like `bg-slate-900/70` keep working). The dark theme
// (default) uses Tailwind's real values. The light theme
// (`<html data-theme="light">`) mirrors each scale: shade N takes the value of
// shade (1000 - N) — slate-100 text becomes slate-900, a cyan-300 accent
// becomes cyan-700, bg-slate-950 becomes slate-50 — and `white` (used for
// overlays like border-white/10 and hover text-white) becomes ink. So the app's
// existing classes read correctly in both themes. Surfaces that need more than
// a mirror (page, cards, sidebar, inputs) use the semantic tokens in
// app/globals.css.

const FAMILIES = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;
const MIRROR: Record<string, string> = Object.fromEntries(
  SHADES.map((s, i) => [s, SHADES[SHADES.length - 1 - i]]),
);

const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const ref = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const colors: Record<string, string | Record<string, string>> = {
  transparent: "transparent",
  current: "currentColor",
  inherit: "inherit",
  // Shadows and dimming backdrops stay black in both themes.
  black: "rgb(0 0 0 / <alpha-value>)",
  white: ref("white"),
};
const darkVars: Record<string, string> = { "--c-white": "255 255 255" };
const lightVars: Record<string, string> = { "--c-white": rgb(palette.slate[900]) };

for (const family of FAMILIES) {
  const scale = palette[family] as Record<string, string>;
  colors[family] = {};
  for (const shade of SHADES) {
    (colors[family] as Record<string, string>)[shade] = ref(`${family}-${shade}`);
    darkVars[`--c-${family}-${shade}`] = rgb(scale[shade]);
    lightVars[`--c-${family}-${shade}`] = rgb(scale[MIRROR[shade]]);
  }
}

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    colors,
    extend: {},
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ":root": darkVars,
        ':root[data-theme="light"]': lightVars,
      });
    }),
  ],
};

export default config;
