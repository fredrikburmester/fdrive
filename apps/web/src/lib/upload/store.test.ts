import { describe, expect, it, vi } from "vitest";
import { createUploadStore, networkErrorMessage, parseUploadErrorMessage } from "./store.ts";
import type { UploadItem } from "./types.ts";
import type { ProgressEventLike, XhrLike } from "./xhr.ts";

class FakeXhr implements XhrLike {
  status = 0;
  responseText = "";
  withCredentials = false;
  openCalls: [string, string][] = [];
  headers: Record<string, string> = {};
  aborted = false;

  private listeners: Record<string, Array<() => void>> = {};
  private progressListeners: Array<(event: ProgressEventLike) => void> = [];

  upload = {
    addEventListener: (_type: "progress", listener: (event: ProgressEventLike) => void) => {
      this.progressListeners.push(listener);
    },
  };

  emitProgress(event: ProgressEventLike): void {
    for (const listener of this.progressListeners) {
      listener(event);
    }
  }

  open(method: string, url: string): void {
    this.openCalls.push([method, url]);
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(): void {}

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

  finishWith(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.emit("load");
  }
}

// Fixed so `x-modified-at` assertions never race two `Date.now()` calls
// against each other (the DOM's default `lastModified` when not given
// explicitly).
const FIXED_LAST_MODIFIED_MS = 1_700_000_000_000;

function makeItem(id: string, overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id,
    file: new File(["x".repeat(10)], `${id}.txt`, { lastModified: FIXED_LAST_MODIFIED_MS }),
    targetPath: `/dest/${id}.txt`,
    relativePath: `${id}.txt`,
    size: 10,
    status: "queued",
    progress: 0,
    attempts: 0,
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("parseUploadErrorMessage", () => {
  it("extracts the message from a well-formed ApiError body", () => {
    const body = JSON.stringify({ error: { kind: "conflict", message: "already exists" } });
    expect(parseUploadErrorMessage(body, 409)).toBe("already exists");
  });

  it("falls back to a generic message for a non-JSON body", () => {
    expect(parseUploadErrorMessage("not json", 500)).toBe("upload failed with status 500");
  });

  it("falls back to a generic message for JSON that is not an ApiError", () => {
    expect(parseUploadErrorMessage(JSON.stringify({ foo: "bar" }), 500)).toBe(
      "upload failed with status 500",
    );
  });

  it("falls back to a generic message for an empty body", () => {
    expect(parseUploadErrorMessage("", 502)).toBe("upload failed with status 502");
  });
});

describe("networkErrorMessage", () => {
  it("uses the Error's message", () => {
    expect(networkErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back to a generic message for a non-Error", () => {
    expect(networkErrorMessage("boom")).toBe("network request failed");
  });
});

describe("createUploadStore", () => {
  function setup(concurrency = 2) {
    const xhrs: FakeXhr[] = [];
    const onUploaded = vi.fn();
    const store = createUploadStore({
      concurrency,
      identityId: "id-1",
      createXhr: () => {
        const xhr = new FakeXhr();
        xhrs.push(xhr);
        return xhr;
      },
      onUploaded,
    });
    return { store, xhrs, onUploaded };
  }

  it("starts uploads up to the concurrency limit and leaves the rest queued", () => {
    const { store, xhrs } = setup(2);
    store.getState().enqueue([makeItem("a"), makeItem("b"), makeItem("c")]);

    const { state } = store.getState();
    expect(state.items.a?.status).toBe("uploading");
    expect(state.items.b?.status).toBe("uploading");
    expect(state.items.c?.status).toBe("queued");
    expect(xhrs).toHaveLength(2);
  });

  it("builds the upload URL and headers from the target path and identity", () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a", { targetPath: "/dest/a.txt" })]);

    expect(xhrs[0]?.openCalls).toEqual([
      ["PUT", "/api/v1/fs/upload?path=%2Fdest%2Fa.txt&mkdirParents=true"],
    ]);
    expect(xhrs[0]?.headers["x-requested-with"]).toBe("fdrive");
    expect(xhrs[0]?.headers["x-identity-id"]).toBe("id-1");
    expect(xhrs[0]?.withCredentials).toBe(true);
    expect(xhrs[0]?.headers["x-modified-at"]).toBe(String(FIXED_LAST_MODIFIED_MS));
  });

  it("dispatches progress updates from the xhr's upload progress events", () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a", { size: 100 })]);

    xhrs[0]?.emitProgress({ lengthComputable: true, loaded: 40, total: 100 });

    expect(store.getState().state.items.a?.progress).toBe(0.4);
  });

  it("marks a successful upload done, calls onUploaded with the parent path, and starts the next item", async () => {
    const { store, xhrs, onUploaded } = setup(1);
    store.getState().enqueue([makeItem("a"), makeItem("b")]);

    xhrs[0]?.finishWith(201, JSON.stringify({ path: "/dest/a.txt" }));
    await flush();

    expect(store.getState().state.items.a?.status).toBe("done");
    expect(onUploaded).toHaveBeenCalledWith("/dest");
    expect(store.getState().state.items.b?.status).toBe("uploading");
    expect(xhrs).toHaveLength(2);
  });

  it("marks a non-2xx response as failed with the parsed message", async () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a")]);

    xhrs[0]?.finishWith(409, JSON.stringify({ error: { kind: "conflict", message: "exists" } }));
    await flush();

    expect(store.getState().state.items.a).toMatchObject({ status: "error", error: "exists" });
  });

  it("marks a network error as failed", async () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a")]);

    xhrs[0]?.emit("error");
    await flush();

    expect(store.getState().state.items.a?.status).toBe("error");
  });

  it("cancels a queued item directly, without touching any xhr", () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a"), makeItem("b")]);

    store.getState().cancel("b");

    expect(store.getState().state.items.b?.status).toBe("cancelled");
    expect(xhrs).toHaveLength(1);
  });

  it("aborts the xhr for an in-flight item and marks it cancelled", async () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a")]);

    store.getState().cancel("a");
    await flush();

    expect(xhrs[0]?.aborted).toBe(true);
    expect(store.getState().state.items.a?.status).toBe("cancelled");
  });

  it("is a no-op to cancel an id that does not exist and has no controller", () => {
    const { store } = setup(1);
    expect(() => store.getState().cancel("missing")).not.toThrow();
  });

  it("retries a failed item, requeuing and restarting it", async () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a")]);
    xhrs[0]?.finishWith(500, "");
    await flush();
    expect(store.getState().state.items.a?.status).toBe("error");

    store.getState().retry("a");

    expect(store.getState().state.items.a?.status).toBe("uploading");
    expect(xhrs).toHaveLength(2);
  });

  it("clears finished items", async () => {
    const { store, xhrs } = setup(1);
    store.getState().enqueue([makeItem("a")]);
    xhrs[0]?.finishWith(200, JSON.stringify({ path: "/dest/a.txt" }));
    await flush();

    store.getState().clearFinished();

    expect(store.getState().state.items.a).toBeUndefined();
  });

  it("omits the identity header and uses a no-op onUploaded when neither is configured", async () => {
    const xhrs: FakeXhr[] = [];
    const store = createUploadStore({
      createXhr: () => {
        const xhr = new FakeXhr();
        xhrs.push(xhr);
        return xhr;
      },
    });

    store.getState().enqueue([makeItem("a")]);
    expect(xhrs[0]?.headers["x-identity-id"]).toBeUndefined();

    xhrs[0]?.finishWith(200, JSON.stringify({ path: "/dest/a.txt" }));
    await flush();
    expect(store.getState().state.items.a?.status).toBe("done");
  });

  it("falls back to a real XMLHttpRequest when createXhr is not configured", async () => {
    const store = createUploadStore();
    store.getState().enqueue([makeItem("a")]);
    await flush();

    // No XMLHttpRequest global in this test environment, so the upload
    // rejects and the item ends up failed rather than hanging forever.
    expect(store.getState().state.items.a?.status).toBe("error");
  });

  it("lets the shell replace onUploaded after construction", async () => {
    const { store, xhrs } = setup(1);
    const replacement = vi.fn();
    store.getState().setOnUploaded(replacement);

    store.getState().enqueue([makeItem("a")]);
    xhrs[0]?.finishWith(200, JSON.stringify({ path: "/dest/a.txt" }));
    await flush();

    expect(replacement).toHaveBeenCalledWith("/dest");
  });
});
