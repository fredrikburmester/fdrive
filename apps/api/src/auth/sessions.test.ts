import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCookie,
  COOKIE_NAME,
  type CookieSecureRequest,
  clearCookie,
  cookieSecureFor,
  cookieSecureForMode,
  generateSessionId,
  hashSessionId,
} from "./sessions";

describe("generateSessionId", () => {
  it("produces a base64url string decoding to 32 bytes", () => {
    const id = generateSessionId();
    expect(Buffer.from(id, "base64url")).toHaveLength(32);
  });

  it("produces distinct ids across calls", () => {
    expect(generateSessionId()).not.toBe(generateSessionId());
  });
});

describe("hashSessionId", () => {
  it("matches a plain sha256 hex digest", () => {
    expect(hashSessionId("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("is deterministic", () => {
    expect(hashSessionId("same")).toBe(hashSessionId("same"));
  });
});

describe("buildCookie", () => {
  it("builds an HttpOnly, SameSite=Lax cookie without Secure when not secure", () => {
    const cookie = buildCookie({ id: "abc123", maxAgeSeconds: 60, secure: false });

    expect(cookie).toBe(`${COOKIE_NAME}=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
    expect(cookie).not.toContain("Secure");
  });

  it("appends Secure when secure is true", () => {
    const cookie = buildCookie({ id: "abc123", maxAgeSeconds: 60, secure: true });

    expect(cookie).toBe(
      `${COOKIE_NAME}=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`,
    );
  });
});

describe("clearCookie", () => {
  it("clears the cookie with Max-Age=0 and an empty value", () => {
    const cookie = clearCookie({ secure: false });

    expect(cookie).toBe(`${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  });

  it("appends Secure when secure is true", () => {
    const cookie = clearCookie({ secure: true });

    expect(cookie).toContain("Secure");
  });
});

describe("cookieSecureForMode", () => {
  it("is always true for mode true", () => {
    expect(
      cookieSecureForMode("true", {
        forwardedProto: undefined,
        trustedProxyHops: 1,
        url: "http://x/",
      }),
    ).toBe(true);
  });

  it("is always false for mode false", () => {
    expect(
      cookieSecureForMode("false", {
        forwardedProto: "https",
        trustedProxyHops: 1,
        url: "https://x/",
      }),
    ).toBe(false);
  });

  describe("mode auto behind a single trusted proxy (the documented default)", () => {
    const behindOneProxy = (forwardedProto: string | undefined, url = "http://x/"): boolean =>
      cookieSecureForMode("auto", { forwardedProto, trustedProxyHops: 1, url });

    it("is true when the proxy reports https", () => {
      expect(behindOneProxy("https")).toBe(true);
    });

    it("is false when the proxy reports http", () => {
      expect(behindOneProxy("http", "https://x/")).toBe(false);
    });

    it("keeps Secure when the client prepends http to the chain", () => {
      // Only the rightmost entry was written by the trusted proxy; the
      // leading "http" is the caller's own and must not downgrade the
      // cookie on an https deployment.
      expect(behindOneProxy("http, https")).toBe(true);
    });

    it("does not let a prepended https add Secure to a plain-http hop", () => {
      expect(behindOneProxy("https, http", "https://x/")).toBe(false);
    });
  });

  describe("mode auto with other trusted hop counts", () => {
    it("reads the outermost trusted hop when two proxies are trusted", () => {
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "https, http",
          trustedProxyHops: 2,
          url: "http://x/",
        }),
      ).toBe(true);
    });

    it("ignores entries to the left of the trusted hops", () => {
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "http, https, http",
          trustedProxyHops: 2,
          url: "http://x/",
        }),
      ).toBe(true);
    });

    it("clamps to the outermost entry present when the chain is shorter than hops", () => {
      // A proxy that replaces x-forwarded-proto (nginx
      // `proxy_set_header X-Forwarded-Proto $scheme`) sends one entry
      // however many hops are configured, so a short chain here is normal
      // rather than suspicious and the single entry still decides.
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "https",
          trustedProxyHops: 2,
          url: "http://x/",
        }),
      ).toBe(true);
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "http",
          trustedProxyHops: 2,
          url: "https://x/",
        }),
      ).toBe(false);
    });

    it("still skips prepended entries once the chain is as long as the hop count", () => {
      // Clamping cannot be exploited: a client can only add entries, which
      // pushes its own value further left of the selected position.
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "https, http, http",
          trustedProxyHops: 2,
          url: "http://x/",
        }),
      ).toBe(false);
    });

    it("ignores the header entirely when no proxy hop is trusted", () => {
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "https",
          trustedProxyHops: 0,
          url: "http://x/",
        }),
      ).toBe(false);
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: "http",
          trustedProxyHops: 0,
          url: "https://x/",
        }),
      ).toBe(true);
    });
  });

  describe("mode auto without a usable header", () => {
    it("falls back to the request URL protocol when the header is absent", () => {
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: undefined,
          trustedProxyHops: 1,
          url: "https://x/",
        }),
      ).toBe(true);
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: undefined,
          trustedProxyHops: 1,
          url: "http://x/",
        }),
      ).toBe(false);
    });

    it("falls back to the request URL protocol for a header of only separators", () => {
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: " , ",
          trustedProxyHops: 1,
          url: "https://x/",
        }),
      ).toBe(true);
    });

    it("is false when the URL cannot be parsed", () => {
      expect(
        cookieSecureForMode("auto", {
          forwardedProto: undefined,
          trustedProxyHops: 1,
          url: "not-a-url",
        }),
      ).toBe(false);
    });
  });
});

describe("cookieSecureFor", () => {
  function contextWith(
    forwardedProto: string | undefined,
    url = "http://internal/",
  ): CookieSecureRequest {
    return {
      req: {
        header: (name: string) => (name === "x-forwarded-proto" ? forwardedProto : undefined),
        url,
      },
    };
  }

  it("reads the forwarded-proto header and request url off a context-shaped object", () => {
    expect(
      cookieSecureFor(
        { fdriveCookieSecure: "auto", fdriveTrustedProxyHops: 1 },
        contextWith("https"),
      ),
    ).toBe(true);
  });

  it("judges the same header by the configured trusted hop count", () => {
    const c = contextWith("http, https");

    expect(cookieSecureFor({ fdriveCookieSecure: "auto", fdriveTrustedProxyHops: 1 }, c)).toBe(
      true,
    );
    expect(cookieSecureFor({ fdriveCookieSecure: "auto", fdriveTrustedProxyHops: 2 }, c)).toBe(
      false,
    );
  });
});
