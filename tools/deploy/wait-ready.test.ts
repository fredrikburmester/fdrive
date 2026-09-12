import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkReadiness, waitForReadiness } from "../../deploy/wait-ready.ts";

function fixture() {
  const features = {
    version: 1,
    revision: 4,
    values: {
      thumbnails: false,
      textSearch: false,
      searchOcr: false,
      semanticSearch: false,
      imageSearch: false,
      pdfOcr: false,
    },
  };
  const office = { version: 1, enabled: false };
  const health = {
    service: "fdrive-api",
    status: "ok",
    subsystems: Object.fromEntries(
      ["core", "index", "thumbnails", "search", "imageSearch", "ocr", "office"].map((name) => [
        name,
        { status: "configured" },
      ]),
    ),
  };
  const tika = { status: "ready", revision: 4 };
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const body = String(url).endsWith("/internal/features")
      ? features
      : String(url).endsWith("/internal/office")
        ? office
        : String(url).endsWith("/runtime")
          ? tika
          : health;
    return new Response(JSON.stringify(body));
  });
  const env = { FDRIVE_WORKER_TOKEN: "test-worker-credential", FDRIVE_READY_TIMEOUT_SECONDS: "10" };
  return { features, office, health, tika, fetchImpl, env };
}

describe("deployment readiness", () => {
  it("runs through Node's stdin entry point used by update.sh", () => {
    const f = fixture();
    const documents = { features: f.features, office: f.office, health: f.health };
    const input = `const documents = ${JSON.stringify(documents)};
globalThis.fetch = async (url) => new Response(JSON.stringify(
  String(url).endsWith('/features') ? documents.features : String(url).endsWith('/office') ? documents.office : documents.health
));\n${readFileSync(new URL("../../deploy/wait-ready.ts", import.meta.url), "utf8")}`;
    const result = spawnSync(process.execPath, ["--input-type=module-typescript"], {
      input,
      encoding: "utf8",
      env: { ...process.env, ...f.env },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Enabled subsystems ready.");
    const failed = spawnSync(process.execPath, ["--input-type=module-typescript"], {
      input,
      encoding: "utf8",
      env: { ...process.env, FDRIVE_READY_TIMEOUT_SECONDS: "0" },
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("must be a positive integer");
  });

  it("accepts first-install disabled workers even when their servers are down", async () => {
    const f = fixture();
    f.health.subsystems.search = { status: "unreachable" };
    f.health.subsystems.imageSearch = { status: "failed" };
    f.health.subsystems.office = { status: "unreachable" };
    expect(await checkReadiness(f.fetchImpl, f.env)).toEqual([]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    expect(f.fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      "x-fdrive-worker-token": "test-worker-credential",
    });
  });

  it.each([
    ["thumbnails", "thumbnails"],
    ["textSearch", "index"],
    ["searchOcr", "index"],
    ["semanticSearch", "search"],
    ["imageSearch", "imageSearch"],
    ["pdfOcr", "ocr"],
  ] as const)("waits for enabled %s despite HTTP 200", async (feature, subsystem) => {
    const f = fixture();
    f.features.values[feature] = true;
    f.health.subsystems[subsystem] = { status: "unreachable" };
    expect(await checkReadiness(f.fetchImpl, f.env)).toContain(`${subsystem}: unreachable`);
  });

  it("waits until Office and search finish starting", async () => {
    const f = fixture();
    f.office.enabled = true;
    f.features.values.semanticSearch = true;
    f.health.subsystems.search = { status: "unreachable" };
    f.health.subsystems.office = { status: "unreachable" };
    const log = vi.fn();
    const sleep = vi.fn(async () => {
      f.health.subsystems.search = { status: "configured" };
      f.health.subsystems.office = { status: "configured" };
    });
    await waitForReadiness({ ...f, sleep, log });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("office: unreachable");
    expect(log).toHaveBeenLastCalledWith("Enabled subsystems ready.");
  });

  it("checks text extraction readiness and configuration revision", async () => {
    const f = fixture();
    f.features.values.textSearch = true;
    f.tika.status = "preparing";
    expect(await checkReadiness(f.fetchImpl, f.env)).toEqual(["text extraction: preparing"]);
    f.tika.status = "ready";
    f.tika.revision = 3;
    expect(await checkReadiness(f.fetchImpl, f.env)).toHaveLength(1);
    f.tika.revision = 4;
    expect(await checkReadiness(f.fetchImpl, f.env)).toEqual([]);
  });

  it("names the text worker when its controller cannot be reached", async () => {
    const f = fixture();
    f.features.values.textSearch = true;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/runtime")) throw new Error("private upstream detail");
      return f.fetchImpl(url, init);
    };
    expect(await checkReadiness(fetchImpl, f.env)).toEqual([
      "text extraction: endpoint unavailable",
    ]);
  });

  it("fails with the outstanding subsystem when the deadline expires", async () => {
    const f = fixture();
    f.office.enabled = true;
    f.health.subsystems.office = { status: "failed" };
    let time = 0;
    const log = vi.fn();
    await expect(
      waitForReadiness({
        ...f,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        log,
      }),
    ).rejects.toThrow("Readiness timed out after 10s: office: failed");
    expect(time).toBe(10_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("retries an API that is still starting without leaking errors", async () => {
    const f = fixture();
    f.fetchImpl.mockRejectedValueOnce(new Error("private-url-and-credential"));
    const log = vi.fn();
    await waitForReadiness({ ...f, sleep: async () => {}, log });
    expect(log.mock.calls.flat().join(" ")).not.toContain("private-url");
    expect(log).toHaveBeenLastCalledWith("Enabled subsystems ready.");
  });

  it("rejects missing configuration, malformed health, and HTTP errors", async () => {
    const f = fixture();
    f.features.version = 2;
    await expect(checkReadiness(f.fetchImpl, f.env)).rejects.toThrow("invalid readiness response");
    f.features.version = 1;
    f.health.service = "wrong-service";
    await expect(checkReadiness(f.fetchImpl, f.env)).rejects.toThrow("invalid readiness response");
    f.fetchImpl.mockResolvedValue(new Response("private response", { status: 503 }));
    await expect(checkReadiness(f.fetchImpl, f.env)).rejects.toThrow("HTTP 503");
  });

  it("does not accept missing or unconfigured enabled subsystems", async () => {
    const f = fixture();
    f.features.values.imageSearch = true;
    delete f.health.subsystems.imageSearch;
    expect(await checkReadiness(f.fetchImpl, f.env)).toEqual(["imageSearch: missing"]);
    f.health.subsystems.imageSearch = { status: "not_configured" };
    expect(await checkReadiness(f.fetchImpl, f.env)).toEqual(["imageSearch: not_configured"]);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects invalid timeout %s", async (timeout) => {
    const f = fixture();
    f.env.FDRIVE_READY_TIMEOUT_SECONDS = timeout;
    await expect(waitForReadiness(f)).rejects.toThrow("must be a positive integer");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
