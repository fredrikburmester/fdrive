import type { NextConfig } from "next";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typedRoutes: true,
  // Next's own gzip compression wraps every outgoing response, including
  // ones proxied through `rewrites()` below, with no awareness that some of
  // them (the `/api/v1/events` SSE stream) are meant to flush every chunk
  // immediately: it buffers small writes waiting for a bigger gzip block,
  // so a real browser (which always sends `Accept-Encoding: gzip`, unlike
  // curl) never sees an event until the connection closes. Disabling
  // compression here fixes that; the API's own responses are small JSON
  // payloads and file streams that do not need it either. Deployed behind
  // Caddy (see PLAN.md §3), Caddy's own compression would have the same
  // problem for this route and needs the same exclusion.
  compress: false,
  // The destination below is fixed at `next build` time (Next.js does not
  // re-read API_INTERNAL_URL at `next start`), so it only matters for local
  // `next dev`. In the compose deployment (see deploy/README.md), Caddy
  // routes /api/* straight to the api service and this rewrite never runs;
  // the production proxy owns /api.
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
