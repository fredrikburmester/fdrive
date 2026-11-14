import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStorage } from "@fdrive/local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OfficeHarness, officeHarness } from "../../test/fixtures/office/harness.ts";

// Saves stream straight into the files folder, which writes a partial file
// beside the document and renames it into place only once it is complete.
describe("Office saves on a real files folder", () => {
  let home: string;
  let h: OfficeHarness;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "office-saves-"));
    await writeFile(join(home, "a.docx"), "hello");
    h = await officeHarness({
      storage: createLocalStorage({ home }),
      config: { maxBytes: 8 },
    });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function locked() {
    const opened = await h.open();
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "writer",
      now: h.clock(),
    });
    return opened;
  }
  function save(
    opened: Awaited<ReturnType<typeof locked>>,
    body: string | ReadableStream<Uint8Array>,
    options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ) {
    return h.callback(opened, {
      contents: true,
      method: "POST",
      headers: { "X-WOPI-Override": "PUT", "X-WOPI-Lock": "writer", ...options.headers },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  /** The document's bytes and every name in its folder, partial files included. */
  async function disk() {
    return {
      names: (await readdir(home)).sort(),
      text: await new Response((await h.storage.download("/a.docx")).body).text(),
    };
  }
  function chunks(...parts: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
  }

  it("publishes a save and reports the version CheckFileInfo then shows", async () => {
    const opened = await locked();
    const response = await save(opened, chunks("new ", "text"));
    expect(response.status).toBe(200);
    expect(await disk()).toEqual({ names: ["a.docx"], text: "new text" });
    const info = (await (await h.callback(opened)).json()) as { Version: string; Size: number };
    expect(info.Size).toBe(8);
    expect(response.headers.get("X-WOPI-ItemVersion")).toBe(info.Version);
  });

  it("moves the version on a same-size write that keeps the modification time, and only then", async () => {
    const opened = await h.open();
    const version = async () =>
      ((await (await h.callback(opened)).json()) as { Version: string }).Version;
    const before = await version();
    expect(await version()).toBe(before);
    await new Response((await h.storage.download("/a.docx")).body).text();
    expect(await version()).toBe(before);
    const at = new Date("2026-01-02T03:04:05Z");
    await utimes(join(home, "a.docx"), at, at);
    const touched = await version();
    expect(touched).not.toBe(before);
    // Linux keeps change times to the kernel's tick (a few milliseconds): wait
    // one out, so the rewrite below cannot share the touch's change time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Rewritten in place, same size, its modification time put back.
    await writeFile(join(home, "a.docx"), "world");
    await utimes(join(home, "a.docx"), at, at);
    expect(await version()).not.toBe(touched);
  });

  it("refuses a body over the limit, leaving the document and no partial file", async () => {
    const opened = await locked();
    expect((await save(opened, chunks("12345", "6789"))).status).toBe(413);
    expect(await disk()).toEqual({ names: ["a.docx"], text: "hello" });
    expect(h.events).toHaveLength(0);
  });

  it("refuses a body shorter than its declared length", async () => {
    const opened = await locked();
    const response = await save(opened, chunks("abc"), { headers: { "Content-Length": "5" } });
    expect(response.status).toBe(400);
    expect(await disk()).toEqual({ names: ["a.docx"], text: "hello" });
  });

  it("publishes nothing for a request aborted while its body arrives", async () => {
    const opened = await locked();
    const abort = new AbortController();
    let pulls = 0;
    const stalled = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("par"));
        // Then nothing more arrives.
        return new Promise(() => {});
      },
    });
    const response = save(opened, stalled, { signal: abort.signal });
    await expect.poll(async () => (await readdir(home)).length).toBe(2);
    abort.abort();
    expect((await response).status).toBe(408);
    expect(await disk()).toEqual({ names: ["a.docx"], text: "hello" });
  });

  it("publishes nothing when edit admission is gone once the body has arrived", async () => {
    let allowed = true;
    h = await officeHarness({
      storage: createLocalStorage({ home }),
      config: { maxBytes: 8 },
      deps: { canEdit: async () => allowed },
    });
    const opened = await locked();
    let release = () => {};
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parts = ["denied"];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = parts.shift();
        if (next === undefined) {
          await arrived;
          controller.close();
        } else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const response = save(opened, body);
    await expect.poll(async () => (await readdir(home)).length).toBe(2);
    allowed = false;
    release();
    expect((await response).status).toBe(403);
    expect(await disk()).toEqual({ names: ["a.docx"], text: "hello" });
  });
});
