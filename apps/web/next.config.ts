import type { NextConfig } from "next";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

// `@fdrive/contracts` and `@fdrive/core` are authored as NodeNext-style ESM
// (relative imports carry an explicit ".js" suffix that points at the
// sibling ".ts" source file, resolved by tsc/tsx/Vite but not by
// Turbopack). Their package.json exports a "development" condition
// pointing straight at that source so tools like `tsx` get live reloads;
// Turbopack picks that same condition in `next dev` and then fails to
// resolve those ".js"-suffixed imports. Aliasing straight to the built
// `dist` output sidesteps both problems, for `next dev` and `next build`
// alike. This means `pnpm --filter @fdrive/contracts build` (and the same
// for `@fdrive/core`) must run at least once before `next dev`/`next build`;
// `pnpm build` at the repo root does this automatically via Turborepo's
// task graph.
const workspacePackagesDist = {
  "@fdrive/contracts": "../../packages/contracts/dist/index.js",
  "@fdrive/core": "../../packages/core/dist/index.js",
};

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typedRoutes: true,
  turbopack: {
    resolveAlias: workspacePackagesDist,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiInternalUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
