import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, buildFixedSecurityHeaders, originOf } from "../next.config.ts";

describe("originOf", () => {
  it("returns null for undefined", () => {
    expect(originOf(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(originOf("")).toBeNull();
  });

  it("returns null for a value that is not a valid absolute URL", () => {
    expect(originOf("not a url")).toBeNull();
  });

  it("returns null for a relative path", () => {
    expect(originOf("/office")).toBeNull();
  });

  it("extracts the origin, dropping the path", () => {
    expect(originOf("https://office.example.com/wopi")).toBe("https://office.example.com");
  });

  it("keeps a non-default port in the origin", () => {
    expect(originOf("http://127.0.0.1:8443/base")).toBe("http://127.0.0.1:8443");
  });
});

describe("buildContentSecurityPolicy", () => {
  it("omits an office origin from frame-src when officePublicUrl is undefined", () => {
    const csp = buildContentSecurityPolicy({ officePublicUrl: undefined });
    expect(csp).toContain("frame-src 'self';");
  });

  it("omits an office origin from frame-src when officePublicUrl is invalid", () => {
    const csp = buildContentSecurityPolicy({ officePublicUrl: "not a url" });
    expect(csp).toContain("frame-src 'self';");
  });

  it("adds the office origin to frame-src when officePublicUrl is a valid URL", () => {
    const csp = buildContentSecurityPolicy({
      officePublicUrl: "https://office.example.com/wopi",
    });
    expect(csp).toContain("frame-src 'self' https://office.example.com;");
  });

  it("keeps 'unsafe-inline' on script-src, required by Next's own inline RSC-streaming scripts", () => {
    const csp = buildContentSecurityPolicy({ officePublicUrl: undefined });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("keeps style-src permissive with 'unsafe-inline'", () => {
    const csp = buildContentSecurityPolicy({ officePublicUrl: undefined });
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("includes every fixed directive exactly once, semicolon-separated", () => {
    const csp = buildContentSecurityPolicy({ officePublicUrl: undefined });
    const directives = csp.split("; ");
    expect(directives).toEqual([
      "default-src 'self'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "frame-src 'self'",
      "worker-src 'self' blob:",
    ]);
  });
});

describe("buildFixedSecurityHeaders", () => {
  it("includes nosniff, a conservative referrer policy, same-origin framing, HSTS, and a restrictive Permissions-Policy", () => {
    const headers = buildFixedSecurityHeaders();
    expect(headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    expect(headers).toContainEqual({
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    });
    expect(headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" });
    expect(headers).toContainEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
    expect(headers).toContainEqual({
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    });
  });
});
