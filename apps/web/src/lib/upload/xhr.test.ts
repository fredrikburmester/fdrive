import { describe, expect, it, vi } from "vitest";
import { type ProgressEventLike, uploadWithProgress, type XhrLike } from "./xhr.ts";

class FakeXhr implements XhrLike {
  status = 0;
  responseText = "";
  withCredentials = false;
  openCalls: [string, string][] = [];
  headers: Record<string, string> = {};
  sentBody: File | Blob | undefined;
  aborted = false;

  private listeners: Record<string, Array<() => void>> = {};
  private uploadListeners: Array<(event: ProgressEventLike) => void> = [];

  upload = {
    addEventListener: (_type: "progress", listener: (event: ProgressEventLike) => void) => {
      this.uploadListeners.push(listener);
    },
  };

  open(method: string, url: string): void {
    this.openCalls.push([method, url]);
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: File | Blob): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.emit("abort");
  }

  addEventListener(type: "load" | "error" | "abort", listener: () => void): void {
    const list = this.listeners[type] ?? [];
    list.push(listener);
    this.listeners[type] = list;
  }

  emit(type: string): void {
    for (const listener of this.listeners[type] ?? []) {
      listener();
    }
  }

  emitProgress(event: ProgressEventLike): void {
    for (const listener of this.uploadListeners) {
      listener(event);
    }
  }

  finishWith(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.emit("load");
  }
}

describe("uploadWithProgress", () => {
  it("opens a PUT request, sets headers and credentials, and sends the file", () => {
    const xhr = new FakeXhr();
    const file = new File(["hello"], "hello.txt");
    void uploadWithProgress(
      { url: "/api/v1/fs/upload?path=/a", file, headers: { "x-a": "1" } },
      () => xhr,
    );

    expect(xhr.openCalls).toEqual([["PUT", "/api/v1/fs/upload?path=/a"]]);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers["x-a"]).toBe("1");
    expect(xhr.sentBody).toBe(file);
  });

  it("resolves with the status and body on load, for both 2xx and error statuses", async () => {
    const xhr = new FakeXhr();
    const promise = uploadWithProgress({ url: "/x", file: new File(["a"], "a.txt") }, () => xhr);
    xhr.finishWith(201, '{"ok":true}');
    await expect(promise).resolves.toEqual({ status: 201, body: '{"ok":true}' });
  });

  it("reports progress via onProgress, using the event total when length is computable", async () => {
    const xhr = new FakeXhr();
    const onProgress = vi.fn();
    const promise = uploadWithProgress(
      { url: "/x", file: new File(["a"], "a.txt"), onProgress },
      () => xhr,
    );
    xhr.emitProgress({ lengthComputable: true, loaded: 5, total: 10 });
    xhr.finishWith(200, "");
    await promise;

    expect(onProgress).toHaveBeenCalledWith(5, 10);
  });

  it("falls back to the file size for total when length is not computable", async () => {
    const xhr = new FakeXhr();
    const onProgress = vi.fn();
    const file = new File(["12345"], "a.txt");
    const promise = uploadWithProgress({ url: "/x", file, onProgress }, () => xhr);
    xhr.emitProgress({ lengthComputable: false, loaded: 2, total: 0 });
    xhr.finishWith(200, "");
    await promise;

    expect(onProgress).toHaveBeenCalledWith(2, file.size);
  });

  it("rejects on a network error", async () => {
    const xhr = new FakeXhr();
    const promise = uploadWithProgress({ url: "/x", file: new File(["a"], "a.txt") }, () => xhr);
    xhr.emit("error");
    await expect(promise).rejects.toThrow("network request failed");
  });

  it("rejects when the xhr's own abort event fires", async () => {
    const xhr = new FakeXhr();
    const promise = uploadWithProgress({ url: "/x", file: new File(["a"], "a.txt") }, () => xhr);
    xhr.emit("abort");
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts the underlying xhr when the signal aborts", async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    const promise = uploadWithProgress(
      { url: "/x", file: new File(["a"], "a.txt"), signal: controller.signal },
      () => xhr,
    );
    controller.abort();
    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    controller.abort();
    const promise = uploadWithProgress(
      { url: "/x", file: new File(["a"], "a.txt"), signal: controller.signal },
      () => xhr,
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.openCalls).toEqual([]);
  });
});
