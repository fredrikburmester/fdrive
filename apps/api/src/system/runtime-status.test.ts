import { describe, expect, it } from "vitest";
import { fetchRuntimeStatus, runtimeError, runtimeFailure } from "./runtime-status.js";

describe("runtimeError", () => {
  it("returns the controller's error string, capped", () => {
    expect(runtimeError({ error: "worker exceeded bounded startup retries" })).toBe(
      "worker exceeded bounded startup retries",
    );
    expect(runtimeError({ error: "x".repeat(500) })).toHaveLength(200);
  });

  it("ignores missing, empty and non-string errors", () => {
    expect(runtimeError({ error: null })).toBeNull();
    expect(runtimeError({ error: "" })).toBeNull();
    expect(runtimeError({ error: 42 })).toBeNull();
    expect(runtimeError("nope")).toBeNull();
    expect(runtimeError(null)).toBeNull();
  });
});

describe("fetchRuntimeStatus", () => {
  it("asks the controller's status port for /runtime and parses status and error", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return Response.json({ status: "failed", error: "worker exceeded bounded startup retries" });
    };
    const result = await fetchRuntimeStatus("http://embed:80/some/path?x=1#y", "8099", fetchImpl);
    expect(seen).toEqual(["http://embed:8099/runtime"]);
    expect(result).toEqual({ status: "failed", error: "worker exceeded bounded startup retries" });
  });

  it("returns null for HTTP errors, non-documents and network failures", async () => {
    expect(
      await fetchRuntimeStatus(
        "http://embed",
        "8099",
        async () => new Response("", { status: 503 }),
      ),
    ).toBeNull();
    expect(
      await fetchRuntimeStatus("http://embed", "8099", async () => Response.json({ status: 7 })),
    ).toBeNull();
    expect(
      await fetchRuntimeStatus("http://embed", "8099", async () => Response.json("text")),
    ).toBeNull();
    expect(
      await fetchRuntimeStatus("http://embed", "8099", async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).toBeNull();
    expect(await fetchRuntimeStatus("not a url", "8099", async () => Response.json({}))).toBeNull();
  });
});

describe("runtimeFailure", () => {
  it("reports only a failed controller, with its reason or a fixed fallback", () => {
    expect(runtimeFailure(null)).toBeNull();
    expect(runtimeFailure({ status: "preparing", error: null })).toBeNull();
    expect(runtimeFailure({ status: "ready", error: "stale" })).toBeNull();
    expect(runtimeFailure({ status: "failed", error: "worker start failed: OSError" })).toBe(
      "worker start failed: OSError",
    );
    expect(runtimeFailure({ status: "failed", error: null })).toBe("Worker could not be started.");
  });
});

it("preserves an explicit controller URL's published port", async () => {
  let seen = "";
  await fetchRuntimeStatus("http://127.0.0.1:58099", null, async (url) => {
    seen = String(url);
    return Response.json({ status: "ready" });
  });
  expect(seen).toBe("http://127.0.0.1:58099/runtime");
});
