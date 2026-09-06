/**
 * Narrow shape of `XMLHttpRequest` this module depends on, so tests can
 * inject a fake instead of relying on a DOM environment. A real
 * `XMLHttpRequest` satisfies this structurally.
 */
export interface ProgressEventLike {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}

export interface XhrUploadLike {
  addEventListener(type: "progress", listener: (event: ProgressEventLike) => void): void;
}

export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: File | Blob): void;
  abort(): void;
  readonly upload: XhrUploadLike;
  status: number;
  responseText: string;
  withCredentials: boolean;
  addEventListener(type: "load" | "error" | "abort", listener: () => void): void;
}

export interface UploadWithProgressOptions {
  readonly url: string;
  readonly file: File;
  readonly headers?: Readonly<Record<string, string>>;
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export interface UploadWithProgressResult {
  readonly status: number;
  readonly body: string;
}

/**
 * Uploads `file` with a PUT request via `XMLHttpRequest`, reporting upload
 * progress through `onProgress`. `fetch` is not used because it does not
 * expose upload progress in most browsers. Resolves with the response
 * status and body text for any completed request, including 4xx/5xx; the
 * caller is responsible for mapping status codes to success or failure.
 * Rejects on a network error or when `signal` aborts the request.
 */
export function uploadWithProgress(
  options: UploadWithProgressOptions,
  createXhr: () => XhrLike,
): Promise<UploadWithProgressResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const xhr = createXhr();

    const onAbort = (): void => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    xhr.addEventListener("error", () => {
      reject(new Error("network request failed"));
    });
    xhr.addEventListener("abort", onAbort);
    xhr.addEventListener("load", () => {
      resolve({ status: xhr.status, body: xhr.responseText });
    });
    xhr.upload.addEventListener("progress", (event) => {
      if (options.onProgress !== undefined) {
        const total = event.lengthComputable ? event.total : options.file.size;
        options.onProgress(event.loaded, total);
      }
    });

    options.signal?.addEventListener("abort", () => xhr.abort());

    xhr.open("PUT", options.url);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.send(options.file);
  });
}
