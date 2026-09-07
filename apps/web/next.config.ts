import type { NextConfig } from "next";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

/**
 * Extracts the origin (`scheme://host[:port]`, no path) from a URL string,
 * or `null` when `value` is absent, empty, or not a valid absolute URL.
 * Used to build the CSP's `frame-src` from `FDRIVE_OFFICE_PUBLIC_URL`
 * without ever embedding a raw, unvalidated environment value in a header:
 * an invalid or missing value is simply dropped rather than breaking the
 * header or widening it unexpectedly.
 */
export function originOf(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface ContentSecurityPolicyOptions {
  /**
   * `process.env.FDRIVE_OFFICE_PUBLIC_URL`, the same variable
   * `apps/api/src/office/config.ts` reads for the office WOPI host's public
   * URL. Its origin is added to `frame-src` so the office editor iframe
   * (`src/components/office/office-frame.tsx`) is allowed to load. Office
   * editing is opt-in (see PLAN.md): when this is absent or invalid,
   * `frame-src` stays at `'self'` only, so the feature fails closed instead
   * of the CSP silently allowing an arbitrary frame source.
   *
   * Read at `next build` time only, exactly like this file's `apiInternalUrl`
   * (see `rewrites()` below and `apps/web/Dockerfile`'s matching comment):
   * verified empirically that a plain runtime `-e`/compose `environment:`
   * value has no effect on an already-built standalone server, only a
   * `--build-arg FDRIVE_OFFICE_PUBLIC_URL=...` does.
   */
  readonly officePublicUrl: string | undefined;
  /**
   * True under `next dev`. React's development build uses `eval` for its
   * debugging features (reconstructing call stacks), so `script-src` gets
   * `'unsafe-eval'` only then; production builds never use `eval` and never
   * get it.
   */
  readonly development?: boolean;
}

/**
 * Builds the `Content-Security-Policy` header value applied to every route
 * by `headers()` below.
 *
 * `script-src` and `style-src` both keep `'unsafe-inline'`, in production
 * as well as development. This was measured against a real `next build` +
 * `next start` (see the e2e suite this file's report covers): the App
 * Router streams RSC payloads to the client through inline
 * `<script>self.__next_f.push(...)</script>` tags that Next itself injects
 * into every page, hashes for which change per page and per build (they
 * embed streamed server data), so neither a fixed hash list nor
 * `'unsafe-inline'`-free `script-src` works without also switching to a
 * per-request nonce threaded through `middleware.ts`. That is a bigger,
 * separate change (dynamic per-request headers, not this file's static
 * `headers()`), tracked as follow-up rather than attempted here; this app
 * also renders no inline script of its own (verified by grepping for
 * `dangerouslySetInnerHTML` and raw `<script>` tags in `src/`), so the
 * risk `'unsafe-inline'` reintroduces is confined to what Next's own
 * framework code injects, not this app's code. `style-src` needs it for
 * the same reason (Next's inlined CSS chunks) plus this app's own inline
 * `style` props.
 */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const officeOrigin = originOf(options.officePublicUrl);
  const frameSrc = ["'self'", ...(officeOrigin === null ? [] : [officeOrigin])].join(" ");

  const directives: readonly [string, string][] = [
    ["default-src", "'self'"],
    ["frame-ancestors", "'self'"],
    ["img-src", "'self' data: blob:"],
    ["media-src", "'self' blob:"],
    ["connect-src", "'self'"],
    ["font-src", "'self' data:"],
    ["style-src", "'self' 'unsafe-inline'"],
    [
      "script-src",
      options.development === true
        ? "'self' 'unsafe-inline' 'unsafe-eval'"
        : "'self' 'unsafe-inline'",
    ],
    ["frame-src", frameSrc],
    ["worker-src", "'self' blob:"],
  ];

  return directives.map(([directive, value]) => `${directive} ${value}`).join("; ");
}

/**
 * Builds the fixed (non-CSP) security headers every route gets: MIME
 * sniffing off, a conservative referrer policy, framing restricted to same
 * origin (defence in depth alongside the CSP's `frame-ancestors`), HSTS
 * (harmless to send over plain HTTP; see `deploy/README.md`'s TLS section
 * for where a real deployment terminates TLS), and a Permissions-Policy
 * that opts this app out of device capabilities it never uses.
 */
export function buildFixedSecurityHeaders(): readonly { key: string; value: string }[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
}

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
  // Applies to every route, including ones proxied through `rewrites()`
  // above: this app never needs a per-route exception. See
  // `docs/workflow/HARDENING-REVIEW.md` item 6.
  async headers() {
    const csp = buildContentSecurityPolicy({
      officePublicUrl: process.env.FDRIVE_OFFICE_PUBLIC_URL,
      development: process.env.NODE_ENV === "development",
    });
    return [
      {
        source: "/:path*",
        headers: [...buildFixedSecurityHeaders(), { key: "Content-Security-Policy", value: csp }],
      },
    ];
  },
};

export default nextConfig;
