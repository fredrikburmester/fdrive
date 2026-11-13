import { describe, expect, it } from "vitest";
import { HttpUrl, isHttpUrl } from "./http-url";

describe("isHttpUrl", () => {
  it("accepts an http URL", () => {
    expect(isHttpUrl("http://dav.test:8080")).toBe(true);
  });

  it("accepts an https URL", () => {
    expect(isHttpUrl("https://dav.example.com")).toBe(true);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(isHttpUrl("ftp://dav.test:21")).toBe(false);
  });

  it("rejects an unparsable string", () => {
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("HttpUrl", () => {
  it("parses a valid http(s) URL", () => {
    expect(HttpUrl.safeParse("http://dav.test:8080").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(HttpUrl.safeParse("").success).toBe(false);
  });

  it("rejects a non-http(s) URL", () => {
    expect(HttpUrl.safeParse("ftp://dav.test").success).toBe(false);
  });
});
