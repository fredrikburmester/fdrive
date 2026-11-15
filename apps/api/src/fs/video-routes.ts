import { spawn } from "node:child_process";
import { pipeline, Readable } from "node:stream";
import { PathQuery, ROUTES } from "@fdrive/contracts";
import { extensionOf } from "@fdrive/core";
import type { AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { normalizeOrThrow, parseQuery, runStorageCall } from "./routes.js";

const API_PREFIX = "/api/v1";

/** Subtitle files are read whole to convert them; anything larger is not a subtitle file. */
export const SUBTITLES_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Reads a video on stdin and writes H.264/AAC fragmented MP4, which browsers
 * play as it arrives, on stdout: at most 1080p, 8-bit 4:2:0 and stereo, so
 * every browser can decode it. Only the pipe protocol is allowed, so a file
 * cannot make ffmpeg open anything else (a playlist's URLs, say).
 */
const FFMPEG_ARGS = [
  ["-protocol_whitelist", "pipe", "-i", "pipe:0"],
  ["-map", "0:v:0", "-map", "0:a:0?"],
  ["-vf", "scale=-2:'min(ih,1080)',format=yuv420p", "-c:v", "libx264", "-preset", "veryfast"],
  ["-c:a", "aac", "-ac", "2"],
  ["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"],
].flat();

/**
 * Pipes `source` through the `ffmpeg` on `PATH` and returns its output. ffmpeg
 * is killed when `signal` aborts or the output is cancelled, so it never
 * outlives the client.
 */
function transcode(source: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const child = spawn("ffmpeg", FFMPEG_ARGS, {
    signal,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "ignore"],
  });
  // A missing executable or an abort: the output then just ends.
  child.on("error", () => {});
  // ffmpeg may stop reading before the end; the pipeline then releases the file.
  pipeline(Readable.fromWeb(source), child.stdin, () => {});
  child.stdout.on("close", () => child.kill("SIGKILL"));
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

/** WebVTT from SubRip: a header, and a dot rather than a comma before the milliseconds. */
export function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${srt.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")}`;
}

/**
 * `GET /fs/transcode` plays a video the browser cannot, and `GET /fs/subtitles`
 * serves the subtitle files next to a video as WebVTT. Both read through the
 * caller's storage, exactly as `GET /fs/download` does.
 */
export function registerVideoRoutes(groups: { authed: AuthedHono }): void {
  const { authed } = groups;

  authed.get(ROUTES.fs.transcode.slice(API_PREFIX.length), async (c) => {
    const principal = c.get("principal");
    const path = normalizeOrThrow(parseQuery(PathQuery, c.req.query()).path);
    const signal = c.req.raw.signal;
    const source = await runStorageCall(() => principal.storage.download(path, { signal }));
    return c.body(transcode(source.body, signal), 200, {
      "Content-Type": "video/mp4",
      "Cache-Control": "private, no-store",
    });
  });

  authed.get(ROUTES.fs.subtitles.slice(API_PREFIX.length), async (c) => {
    const principal = c.get("principal");
    const path = normalizeOrThrow(parseQuery(PathQuery, c.req.query()).path);
    const ext = extensionOf(path);
    if (ext !== ".srt" && ext !== ".vtt") {
      throw new ApiHttpError("bad_request", "not a subtitle file");
    }
    const file = await runStorageCall(() =>
      principal.storage.download(path, { signal: c.req.raw.signal }),
    );
    if (file.contentLength > SUBTITLES_MAX_BYTES) {
      await file.body.cancel();
      throw new ApiHttpError("payload_too_large", "subtitle file is too large");
    }
    const text = await new Response(file.body).text();
    return c.body(ext === ".srt" ? srtToVtt(text) : text, 200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "private, no-store",
    });
  });
}
