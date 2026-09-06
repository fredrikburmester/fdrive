import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    environment: "node",
    coverage: {
      include: ["src/lib/**"],
    },
  },
});
