import { describe, expect, it, vi } from "vitest";
import {
  fetchPublicPreview,
  PUBLIC_BLOB_LIMIT,
  PUBLIC_TEXT_LIMIT,
  publicPreviewKind,
} from "./preview";

const signal = () => new AbortController().signal;
describe("public preview policy", () => {
  it("keeps Office, archives and active SVG download-only and caps buffered kinds", () => {
    for (const name of [
      "document.docx",
      "sheet.xlsx",
      "deck.pptx",
      "file.zip",
      "vector.SVG",
      "vector.svgz",
      "unknown",
    ])
      expect(publicPreviewKind(name)).toBe("none");
    for (const [name, kind] of [
      ["image.PNG", "image"],
      ["song.wav", "audio"],
      ["film.mp4", "video"],
      ["page.pdf", "pdf"],
      ["readme.md", "markdown"],
      ["code.ts", "code"],
      ["hello.txt", "text"],
      ["page.html", "code"],
    ])
      expect(publicPreviewKind(name ?? "")).toBe(kind);
    for (const name of ["a.txt", "a.ts", "a.md"])
      expect(publicPreviewKind(name, PUBLIC_TEXT_LIMIT + 1)).toBe("none");
    expect(publicPreviewKind("a.pdf", PUBLIC_BLOB_LIMIT + 1)).toBe("none");
    expect(publicPreviewKind("a.pdf", PUBLIC_BLOB_LIMIT)).toBe("pdf");
  });
  it("streams bounded text and real PDF without credentials from the active login", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("hello 日本"));
    const abort = signal();
    expect(await fetchPublicPreview("/public/download", "text", abort, fetcher)).toBe("hello 日本");
    expect(fetcher).toHaveBeenCalledWith("/public/download", {
      signal: abort,
      credentials: "same-origin",
      cache: "no-store",
    });
    const pdf = await fetchPublicPreview(
      "/p",
      "pdf",
      signal(),
      async () => new Response("%PDF-1.7\nbody"),
    );
    expect(pdf).toBeInstanceOf(Blob);
    if (typeof pdf !== "string") {
      expect(pdf.type).toBe("application/pdf");
      expect(await pdf.text()).toContain("%PDF-");
    }
    await expect(
      fetchPublicPreview("/p", "pdf", signal(), async () => new Response("<html>")),
    ).rejects.toThrow("cannot be previewed as a PDF");
    expect(await fetchPublicPreview("/p", "code", signal(), async () => new Response(null))).toBe(
      "",
    );
  });
  it("rejects advertised and chunked overflow before retaining an unbounded body", async () => {
    const cancel = vi.fn();
    const advertised = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(PUBLIC_TEXT_LIMIT + 1) },
    });
    await expect(
      fetchPublicPreview("/p", "text", signal(), async () => advertised),
    ).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
    const cancelChunked = vi.fn();
    const chunked = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(PUBLIC_TEXT_LIMIT));
          controller.enqueue(new Uint8Array(1));
        },
        cancel: cancelChunked,
      }),
    );
    await expect(
      fetchPublicPreview("/p", "markdown", signal(), async () => chunked),
    ).rejects.toThrow("too large");
    expect(cancelChunked).toHaveBeenCalledOnce();
    await expect(
      fetchPublicPreview(
        "/p",
        "pdf",
        signal(),
        async () =>
          new Response(null, { headers: { "content-length": String(PUBLIC_BLOB_LIMIT + 1) } }),
      ),
    ).rejects.toThrow("too large");
  });
  it("cancels pending or already-aborted bodies and never returns stale preview text", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const promise = fetchPublicPreview("/p", "text", controller.signal, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    const already = new AbortController();
    already.abort();
    const cancelAlready = vi.fn();
    await expect(
      fetchPublicPreview(
        "/p",
        "text",
        already.signal,
        async () => new Response(new ReadableStream({ cancel: cancelAlready })),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelAlready).toHaveBeenCalledOnce();
  });
  it("shows bounded API errors and generic failures for arbitrary upstream bodies", async () => {
    await expect(
      fetchPublicPreview("/p", "text", signal(), async () =>
        Response.json({ error: { kind: "forbidden", message: "Wrong password" } }, { status: 403 }),
      ),
    ).rejects.toThrow("Wrong password");
    for (const body of ["{}", "<html>upstream</html>", "x".repeat(8193)])
      await expect(
        fetchPublicPreview("/p", "text", signal(), async () => new Response(body, { status: 403 })),
      ).rejects.toThrow("Could not open this file");
  });
});
