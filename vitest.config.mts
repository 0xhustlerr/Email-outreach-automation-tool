import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

// Only here to resolve the `@/` import alias (tsconfig "paths"), so tests can
// import modules that use it. Everything else is Vitest's defaults.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
