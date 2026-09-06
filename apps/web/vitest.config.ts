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
    coverage: {
      include: ["src/lib/**"],
    },
  },
});
