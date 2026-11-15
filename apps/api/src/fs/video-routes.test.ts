import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStorage } from "@fdrive/local";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { registerVideoRoutes, SUBTITLES_MAX_BYTES, srtToVtt } from "./video-routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/**
 * Puts an `ffmpeg` first on `PATH` that records its pid and arguments, then
 * runs `body`; returns the folder it records them in.
 */
async function fakeFfmpeg(body: string): Promise<string> {
  const dir = await tempDir("fdrive-fake-ffmpeg-");
  const path = join(dir, "ffmpeg");
  await writeFile(
    path,
    `#!/bin/sh\necho $$ > "${dir}/pid"\nprintf '%s\\n' "$@" > "${dir}/args"\n${body}\n`,
  );
  await chmod(path, 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  return dir;
}

async function buildApp(files: Record<string, string>, signedIn = true) {
  const home = await tempDir("fdrive-video-home-");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(home, name), content);
  }
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-0000000000a1",
    username: "alice",
    storage: createLocalStorage({ home }),
    isAdmin: false,
  };
  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as unknown as Logger,
    version: "1.0.0",
    startedAt: new Date(),
    clock: () => new Date(),
    principalResolver: async () => (signedIn ? principal : null),
    setupRequired: async () => false,
    registerRoutes: (groups) => registerVideoRoutes(groups),
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(dir: string): Promise<number> {
  let pid = "";
  await vi.waitFor(async () => {
    pid = (await readFile(join(dir, "pid"), "utf8")).trim();
    expect(pid).not.toBe("");
  });
  return Number(pid);
}

describe("GET /fs/transcode", () => {
  it("streams the file through ffmpeg as MP4, reading only from stdin", async () => {
    const ffmpeg = await fakeFfmpeg("exec cat");
    const app = await buildApp({ "Movie.mkv": "matroska bytes" });

    const res = await app.request("/api/v1/fs/transcode?path=%2FMovie.mkv");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("matroska bytes");
    const args = (await readFile(join(ffmpeg, "args"), "utf8")).trim().split("\n");
    expect(args.slice(0, 4)).toEqual(["-protocol_whitelist", "pipe", "-i", "pipe:0"]);
    expect(args.at(-1)).toBe("pipe:1");
  });

  it("kills ffmpeg when the client stops reading", async () => {
    const ffmpeg = await fakeFfmpeg("exec sleep 30");
    const app = await buildApp({ "Movie.mkv": "matroska bytes" });

    const res = await app.request("/api/v1/fs/transcode?path=%2FMovie.mkv");
    const pid = await pidOf(ffmpeg);
    await res.body?.cancel();

    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("kills ffmpeg when the request is aborted", async () => {
    const ffmpeg = await fakeFfmpeg("exec sleep 30");
    const app = await buildApp({ "Movie.mkv": "matroska bytes" });
    const controller = new AbortController();

    await app.request("/api/v1/fs/transcode?path=%2FMovie.mkv", { signal: controller.signal });
    const pid = await pidOf(ffmpeg);
    controller.abort();

    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("ends the stream when ffmpeg cannot start", async () => {
    vi.stubEnv("PATH", await tempDir("fdrive-empty-path-"));
    const app = await buildApp({ "Movie.mkv": "matroska bytes" });

    const res = await app.request("/api/v1/fs/transcode?path=%2FMovie.mkv");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("refuses a file the caller cannot read and an anonymous caller", async () => {
    await fakeFfmpeg("exec cat");
    const missing = await (await buildApp({})).request("/api/v1/fs/transcode?path=%2FMovie.mkv");
    const anonymous = await (await buildApp({ "Movie.mkv": "x" }, false)).request(
      "/api/v1/fs/transcode?path=%2FMovie.mkv",
    );

    expect(missing.status).toBe(404);
    expect(anonymous.status).toBe(401);
  });
});

describe("GET /fs/subtitles", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHej, världen\r\n";

  it("serves SubRip as WebVTT", async () => {
    const app = await buildApp({ "Movie.sv.srt": srt });

    const res = await app.request("/api/v1/fs/subtitles?path=%2FMovie.sv.srt");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(await res.text()).toBe(
      "WEBVTT\n\n1\r\n00:00:01.000 --> 00:00:02.500\r\nHej, världen\r\n",
    );
  });

  it("serves WebVTT unchanged", async () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n";
    const app = await buildApp({ "Movie.vtt": vtt });

    const res = await app.request("/api/v1/fs/subtitles?path=%2FMovie.vtt");

    expect(await res.text()).toBe(vtt);
  });

  it("refuses other files, oversized files, missing files and anonymous callers", async () => {
    const app = await buildApp({
      "Movie.mkv": "x",
      "Huge.srt": " ".repeat(SUBTITLES_MAX_BYTES + 1),
    });
    const anonymous = await buildApp({ "Movie.srt": srt }, false);

    const statuses = await Promise.all(
      [
        app.request("/api/v1/fs/subtitles?path=%2FMovie.mkv"),
        app.request("/api/v1/fs/subtitles?path=%2FHuge.srt"),
        app.request("/api/v1/fs/subtitles?path=%2FMissing.srt"),
        anonymous.request("/api/v1/fs/subtitles?path=%2FMovie.srt"),
      ].map(async (res) => (await res).status),
    );

    expect(statuses).toEqual([400, 413, 404, 401]);
  });
});

describe("srtToVtt", () => {
  it("adds the header and rewrites every timestamp", () => {
    expect(srtToVtt("2\n01:02:03,004 --> 01:02:05,006\nHi\n")).toBe(
      "WEBVTT\n\n2\n01:02:03.004 --> 01:02:05.006\nHi\n",
    );
  });
});
