import { fileURLToPath } from "node:url";
import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  // The app's own tsconfig sets jsx: "preserve" for Next.js's compiler;
  // Vite's oxc transform otherwise inherits that from tsconfig.json and
  // leaves raw JSX in the output, so a concrete runtime is set here.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // The base preset's `include` only matches `.test.ts`; this app also has
    // jsdom-environment component tests (`.test.tsx`, opted into jsdom per
    // file via a `// @vitest-environment jsdom` docblock), which need their
    // own pattern here or they are silently never run.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts"],
    // One worker per file puts ordinary imports past 5 s when the host is
    // loaded; the extra headroom covers startup, not a lazy assertion.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      include: ["src/lib/**"],
    },
  },
});
