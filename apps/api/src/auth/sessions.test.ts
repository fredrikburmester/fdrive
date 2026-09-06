import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCookie,
  COOKIE_NAME,
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
    expect(cookieSecureForMode("true", { forwardedProto: undefined, url: "http://x/" })).toBe(true);
  });

  it("is always false for mode false", () => {
    expect(cookieSecureForMode("false", { forwardedProto: "https", url: "https://x/" })).toBe(
      false,
    );
  });

  describe("mode auto", () => {
    it("is true when x-forwarded-proto is https", () => {
      expect(cookieSecureForMode("auto", { forwardedProto: "https", url: "http://x/" })).toBe(true);
    });

    it("is false when x-forwarded-proto is http", () => {
      expect(cookieSecureForMode("auto", { forwardedProto: "http", url: "https://x/" })).toBe(
        false,
      );
    });

    it("uses the first hop when x-forwarded-proto is a comma list", () => {
      expect(cookieSecureForMode("auto", { forwardedProto: "https, http", url: "http://x/" })).toBe(
        true,
      );
    });

    it("falls back to the request URL protocol when the header is absent", () => {
      expect(cookieSecureForMode("auto", { forwardedProto: undefined, url: "https://x/" })).toBe(
        true,
      );
      expect(cookieSecureForMode("auto", { forwardedProto: undefined, url: "http://x/" })).toBe(
        false,
      );
    });

    it("is false when the URL cannot be parsed", () => {
      expect(cookieSecureForMode("auto", { forwardedProto: undefined, url: "not-a-url" })).toBe(
        false,
      );
    });
  });
});

describe("cookieSecureFor", () => {
  it("reads the forwarded-proto header and request url off a context-shaped object", () => {
    const c = {
      req: {
        header: (name: string) => (name === "x-forwarded-proto" ? "https" : undefined),
        url: "http://internal/",
      },
    };

    expect(cookieSecureFor({ fdriveCookieSecure: "auto" }, c)).toBe(true);
  });
});
