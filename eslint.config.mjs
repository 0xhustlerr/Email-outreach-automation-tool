// Flat ESLint config.
//
// Next 16 REMOVED `next lint` — it now reads a trailing "lint" as the project
// directory and dies with "Invalid project directory". So ESLint runs directly
// (`npm run lint` -> `eslint .`) and this file is the only source of truth.
//
// eslint-config-next 16 ships native flat configs, so there's no FlatCompat
// shim and no @eslint/eslintrc dependency. core-web-vitals already includes the
// base "next" config; the typescript entry is separate and adds
// typescript-eslint's recommended rules.

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Named rather than exported anonymously, or the config trips the preset's own
// import/no-anonymous-default-export rule when ESLint lints this file.
const config = [
  // A config block containing ONLY `ignores` applies globally.
  {
    ignores: [
      ".next/**",
      "dist/**", // packaged portable app (build-portable.ps1)
      "launcher/**", // .NET tray host — C#/PowerShell, nothing to lint
      "Email Finder.exe.WebView2/**", // WebView2 runtime profile
      ".data/**", // SQLite + local runtime state
      "**/*.tmp.*", // stray editor/build temp copies
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
