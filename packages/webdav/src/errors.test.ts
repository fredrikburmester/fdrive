import { describe, expect, it } from "vitest";
import {
  extractDetail,
  mapStatusToKind,
  toNetworkError,
  toWebdavError,
  WebdavError,
} from "./errors.js";

describe("mapStatusToKind", () => {
  it.each([
    [400, "bad_request"],
    [416, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [405, "conflict"],
    [409, "conflict"],
    [412, "conflict"],
    [423, "conflict"],
    [413, "payload_too_large"],
    [507, "payload_too_large"],
    [429, "rate_limited"],
    [301, "server"],
    [500, "server"],
    [503, "server"],
    [418, "unexpected"],
    [200, "unexpected"],
  ] as const)("maps %i to %s", (status, kind) => {
    expect(mapStatusToKind(status)).toBe(kind);
  });
});

describe("extractDetail", () => {
  it("strips markup and collapses whitespace", () => {
    expect(extractDetail("<html><body>\n  Not   <b>Found</b>\n</body></html>")).toBe("Not Found");
  });

  it("returns null for an empty or markup-only body", () => {
    expect(extractDetail("")).toBeNull();
    expect(extractDetail("<br/>")).toBeNull();
  });

  it("truncates long bodies", () => {
    expect(extractDetail("x".repeat(600))?.length).toBe(500);
  });
});

describe("toWebdavError", () => {
  it("carries status, kind and a trimmed detail", async () => {
    const error = await toWebdavError(new Response("<p>gone</p>", { status: 404 }));
    expect(error).toBeInstanceOf(WebdavError);
    expect(error.kind).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.detail).toBe("gone");
    expect(error.message).toContain("404");
  });

  it("reads only the first few kilobytes of a large body", async () => {
    const error = await toWebdavError(new Response("y".repeat(100_000), { status: 500 }));
    expect(error.detail?.length).toBe(500);
  });

  it("tolerates a body whose cancel rejects", async () => {
    const stubborn = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        throw new Error("cannot cancel");
      },
    });
    expect((await toWebdavError(new Response(stubborn, { status: 500 }))).kind).toBe("server");
  });

  it("tolerates a missing or unreadable body", async () => {
    expect((await toWebdavError(new Response(null, { status: 503 }))).detail).toBeNull();
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    expect((await toWebdavError(new Response(broken, { status: 500 }))).detail).toBeNull();
  });
});

describe("toNetworkError", () => {
  it("wraps an Error and a non-Error cause", () => {
    expect(toNetworkError(new Error("refused")).message).toContain("refused");
    expect(toNetworkError("odd").kind).toBe("network");
    expect(toNetworkError("odd").message).toContain("odd");
  });
});
