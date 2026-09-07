import { describe, expect, it, vi } from "vitest";
import type { ProgressEventLike, XhrLike } from "@/lib/upload/xhr";
import { createShareUploadQueue, publicUploadError, validatePublicUploadFiles } from "./uploads";

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

const id = "00000000-0000-4000-8000-000000000001";
function harness() {
  const requests: FakeXhr[] = [];
  let sequence = 0;
  const queue = createShareUploadQueue(id, {
    concurrency: 1,
    createId: () => String(++sequence),
    createXhr: () => {
      const xhr = new FakeXhr();
      requests.push(xhr);
      return xhr;
    },
  });
  const xhr = (index: number) => {
    const request = requests[index];
    if (!request) throw new Error("Missing request");
    return request;
  };
  return { queue, requests, xhr };
}
describe("public share uploads", () => {
  it("validates flat filenames and returns only bounded API error messages", () => {
    validatePublicUploadFiles([new File(["x"], "日本%.txt")]);
    expect(() => validatePublicUploadFiles([new File([], "a/b")])).toThrow();
    const nested = new File([], "a.txt");
    Object.defineProperty(nested, "webkitRelativePath", { value: "dir/a.txt" });
    expect(() => validatePublicUploadFiles([nested])).toThrow("Folder uploads");
    expect(
      publicUploadError(
        JSON.stringify({ error: { kind: "forbidden", message: "Wrong password" } }),
        403,
      ),
    ).toBe("Wrong password");
    expect(publicUploadError("{}", 401)).toContain("Upload denied");
    expect(publicUploadError("bad", 403)).toContain("Upload denied");
    expect(publicUploadError("x".repeat(8193), 500)).toContain("upload failed");
    expect(() => createShareUploadQueue("bad")).toThrow();
  });
  it("captures capability-only URLs, streams progress and starts queued files after completion", async () => {
    const { queue, xhr, requests } = harness();
    const notify = vi.fn();
    const off = queue.subscribe(notify);
    queue.enqueue([new File(["hello"], "日本%.txt"), new File([], "empty.txt")]);
    expect(requests).toHaveLength(1);
    expect(xhr(0).openCalls).toEqual([
      ["PUT", `/api/v1/public/shares/${id}/upload?path=%2F%E6%97%A5%E6%9C%AC%25.txt`],
    ]);
    expect(xhr(0).headers).toEqual({ "x-requested-with": "fdrive" });
    expect(xhr(0).withCredentials).toBe(true);
    xhr(0).emitProgress({ lengthComputable: true, loaded: 2, total: 5 });
    expect(queue.getSnapshot()[0]?.progress).toBe(40);
    xhr(0).emitProgress({ lengthComputable: true, loaded: 10, total: 5 });
    expect(queue.getSnapshot()[0]?.progress).toBe(100);
    queue.retry("1");
    queue.retry("unknown");
    xhr(0).finishWith(201, "{}");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    xhr(1).emitProgress({ lengthComputable: false, loaded: 0, total: 0 });
    expect(queue.getSnapshot()[1]?.progress).toBe(0);
    xhr(1).finishWith(200, "{}");
    await vi.waitFor(() =>
      expect(queue.getSnapshot().every((item) => item.status === "done")).toBe(true),
    );
    queue.cancel("1");
    queue.cancel("unknown");
    expect(queue.getSnapshot()[0]?.status).toBe("done");
    expect(notify).toHaveBeenCalled();
    off();
    const count = notify.mock.calls.length;
    queue.dispose();
    expect(notify).toHaveBeenCalledTimes(count);
  });
  it("retries password and network failures without retargeting the capability", async () => {
    const { queue, xhr, requests } = harness();
    queue.enqueue([new File(["x"], "a.txt")]);
    xhr(0).finishWith(
      403,
      JSON.stringify({ error: { kind: "forbidden", message: "Wrong password" } }),
    );
    await vi.waitFor(() => expect(queue.getSnapshot()[0]?.error).toBe("Wrong password"));
    queue.retry("1");
    expect(requests).toHaveLength(2);
    xhr(1).emit("error");
    await vi.waitFor(() => expect(queue.getSnapshot()[0]?.error).toContain("interrupted"));
    queue.retry("1");
    xhr(2).emit("abort");
    await vi.waitFor(() => expect(queue.getSnapshot()[0]?.status).toBe("error"));
    expect(queue.getSnapshot()[0]?.error).toBeNull();
    queue.retry("1");
    xhr(3).finishWith(204, "");
    await vi.waitFor(() => expect(queue.getSnapshot()[0]?.status).toBe("done"));
    queue.dispose();
  });
  it("cancels queued/inflight files and ignores late events from old credential generations", async () => {
    const { queue, xhr, requests } = harness();
    queue.enqueue([new File(["a"], "a.txt"), new File(["b"], "b.txt")]);
    queue.cancel("2");
    expect(queue.getSnapshot()[1]?.status).toBe("cancelled");
    queue.cancel("1");
    expect(xhr(0).aborted).toBe(true);
    queue.retry("1");
    expect(requests).toHaveLength(2);
    xhr(0).emitProgress({ lengthComputable: true, loaded: 1, total: 1 });
    xhr(0).finishWith(200, "{}");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.getSnapshot()[0]?.status).toBe("uploading");
    expect(queue.getSnapshot()[0]?.progress).toBe(0);
    queue.credentialsChanged();
    expect(xhr(1).aborted).toBe(true);
    xhr(1).finishWith(200, "{}");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.getSnapshot().map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
    queue.retry("1");
    xhr(2).finishWith(200, "{}");
    await vi.waitFor(() => expect(queue.getSnapshot()[0]?.status).toBe("done"));
    queue.credentialsChanged();
    expect(queue.getSnapshot()[0]?.status).toBe("done");
    queue.enqueue([new File(["c"], "c.txt")]);
    queue.dispose();
    expect(xhr(3).aborted).toBe(true);
    expect(queue.getSnapshot()).toEqual([]);
    queue.enqueue([new File([], "ignored")]);
    queue.retry("1");
    expect(requests).toHaveLength(4);
    queue.activate();
    queue.enqueue([new File([], "new")]);
    expect(requests).toHaveLength(5);
    queue.dispose();
  });
});
