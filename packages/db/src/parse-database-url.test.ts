import { describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "./parse-database-url.js";

describe("parseDatabaseUrl", () => {
  it("accepts a postgres:// URL with a database name", () => {
    const result = parseDatabaseUrl("postgres://user:pass@localhost:5432/fdrive");

    expect(result).toEqual({ ok: true, value: "postgres://user:pass@localhost:5432/fdrive" });
  });

  it("accepts a postgresql:// URL with a database name", () => {
    const result = parseDatabaseUrl("postgresql://user:pass@localhost:5432/fdrive");

    expect(result.ok).toBe(true);
  });

  it("rejects a non-URL string", () => {
    const result = parseDatabaseUrl("not a url");

    expect(result).toEqual({ ok: false, reason: "not a valid URL" });
  });

  it("rejects an unsupported protocol", () => {
    const result = parseDatabaseUrl("mysql://user:pass@localhost:3306/fdrive");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unsupported protocol");
    }
  });

  it("rejects a URL with no database name", () => {
    const result = parseDatabaseUrl("postgres://user:pass@localhost:5432/");

    expect(result).toEqual({ ok: false, reason: "missing database name" });
  });

  it("rejects a URL with an empty path entirely", () => {
    const result = parseDatabaseUrl("postgres://user:pass@localhost:5432");

    expect(result.ok).toBe(false);
  });
});
