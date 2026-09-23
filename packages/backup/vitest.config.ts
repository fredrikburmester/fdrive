import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    // The roundtrip suite snapshots real PostgreSQL through encryption and
    // compression. On a four-core CI runner beside the other packages' suites a
    // single test outlasts Vitest's 5 s default.
    testTimeout: 30_000,
  },
});
