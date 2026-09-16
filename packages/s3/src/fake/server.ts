import { createHash, createHmac, randomUUID } from "node:crypto";

/** A key pair the fake accepts, with optional restrictions. */
export interface FakeS3Key {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Object keys under any of these prefixes answer `AccessDenied` for this pair. */
  readonly denyPrefixes?: readonly string[];
  /** Every write answers `AccessDenied` for this pair. */
  readonly readOnly?: boolean;
}

export interface FakeS3Object {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly lastModified: Date;
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag: string;
}

/** What a request resolved to, handed to an interceptor before the fake answers it. */
export interface ParsedRequest {
  readonly method: string;
  readonly bucket: string;
  readonly key: string;
  readonly query: URLSearchParams;
}

export interface FakeS3Options {
  /** Origin the fake answers for; anything else is a network error. Default `http://s3.test`. */
  readonly origin?: string;
  /** Buckets that exist. Default `["bucket"]`. */
  readonly buckets?: readonly string[];
  readonly keys: readonly FakeS3Key[];
  /** Initial objects, keyed `bucket/key`, with text content. */
  readonly objects?: Readonly<Record<string, string>>;
  /** Verify SigV4 signatures against the pair's secret. Default true. */
  readonly verifySignatures?: boolean;
  /** Answers a request itself when it returns a `Response`; used to inject failures. */
  readonly intercept?: (request: Request, parsed: ParsedRequest) => Response | null;
  readonly now?: () => Date;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeS3Server {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
  /** The live object map of a bucket, for seeding and assertions. */
  objects(bucket: string): Map<string, FakeS3Object>;
  /** Stores text or bytes at `key`; the shortcut tests use to seed a bucket. */
  put(bucket: string, key: string, content: string | Uint8Array, contentType?: string): void;
  /** Multipart uploads started and neither completed nor aborted. */
  pendingUploads(): number;
}

interface MultipartUpload {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly metadata: Record<string, string>;
  readonly parts: Map<number, Uint8Array>;
}

const DEFAULT_ORIGIN = "http://s3.test";
const DEFAULT_BUCKET = "bucket";
const DEFAULT_MAX_KEYS = 1000;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const XMLNS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Uint8Array, data: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

/** Parses `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`; `null` when unsatisfiable or malformed. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match as unknown as [string, string, string];
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return null;
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}

/**
 * An in-memory S3 server exposed as `fetch`, for unit tests of the client,
 * adapter, module and the API. It speaks the REST shapes the SDK sends
 * path-style (`/bucket/key`): `ListObjectsV2` with delimiter and
 * continuation tokens, `GetObject` with `Range`, `If-Match` and
 * `If-Unmodified-Since`, `HeadObject`, `PutObject` with metadata and
 * `If-None-Match: *`, `CopyObject`, `DeleteObject`, `DeleteObjects` and the
 * multipart create, part, complete and abort calls. Signatures are verified
 * against each pair's secret with real SigV4, so a wrong secret is refused
 * the way a real server refuses it.
 */
export function createFakeS3Server(options: FakeS3Options): FakeS3Server {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const now = options.now ?? (() => new Date());
  const verify = options.verifySignatures ?? true;
  const buckets = new Map<string, Map<string, FakeS3Object>>();
  for (const name of options.buckets ?? [DEFAULT_BUCKET]) buckets.set(name, new Map());
  const uploads = new Map<string, MultipartUpload>();
  const requests: RecordedRequest[] = [];

  function store(
    bucket: Map<string, FakeS3Object>,
    key: string,
    bytes: Uint8Array,
    contentType: string,
    metadata: Record<string, string>,
    etag = `"${md5Hex(bytes)}"`,
  ): FakeS3Object {
    const object: FakeS3Object = { bytes, contentType, lastModified: now(), metadata, etag };
    bucket.set(key, object);
    return object;
  }

  for (const [path, content] of Object.entries(options.objects ?? {})) {
    const slash = path.indexOf("/");
    const bucket = buckets.get(path.slice(0, slash));
    if (bucket === undefined) throw new Error(`fake S3: unknown bucket in ${path}`);
    store(bucket, path.slice(slash + 1), new TextEncoder().encode(content), "text/plain", {});
  }

  function xmlError(status: number, code: string, message: string, resource = ""): Response {
    const body = `${XML_HEADER}<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message><Resource>${escapeXml(resource)}</Resource><RequestId>${randomUUID()}</RequestId></Error>`;
    return new Response(body, {
      status,
      headers: { "content-type": "application/xml", "x-amz-request-id": randomUUID() },
    });
  }

  function xml(status: number, body: string, headers: Record<string, string> = {}): Response {
    return new Response(`${XML_HEADER}${body}`, {
      status,
      headers: { "content-type": "application/xml", "x-amz-request-id": randomUUID(), ...headers },
    });
  }

  function objectHeaders(object: FakeS3Object): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": object.contentType,
      "last-modified": object.lastModified.toUTCString(),
      etag: object.etag,
      "accept-ranges": "bytes",
      "x-amz-request-id": randomUUID(),
    };
    for (const [name, value] of Object.entries(object.metadata)) {
      headers[`x-amz-meta-${name}`] = value;
    }
    return headers;
  }

  function metadataFrom(headers: Headers): Record<string, string> {
    const metadata: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
    });
    return metadata;
  }

  /** The signature's validity for `pair`, recomputed from the request the way a server does. */
  function signatureMatches(
    request: Request,
    url: URL,
    pair: FakeS3Key,
    credentialScope: string,
    signedHeaders: string,
    signature: string,
    payloadHash: string,
  ): boolean {
    const [date, region, service] = credentialScope.split("/") as [string, string, string];
    const canonicalQuery = url.search
      .slice(1)
      .split("&")
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        // The SDK always sends `name=value`, `name=` for a flag such as `?uploads=`.
        const index = pair.indexOf("=");
        return [pair.slice(0, index), pair.slice(index + 1)] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const canonicalHeaders = signedHeaders
      .split(";")
      .map((name) => {
        const value = name === "host" ? url.host : (request.headers.get(name) ?? "");
        return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
      })
      .join("");
    const canonicalRequest = [
      request.method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      request.headers.get("x-amz-date") ?? "",
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${pair.secretAccessKey}`, date), region), service),
      "aws4_request",
    );
    return Buffer.from(hmac(signingKey, stringToSign)).toString("hex") === signature;
  }

  async function authenticate(
    request: Request,
    url: URL,
    body: Uint8Array,
  ): Promise<FakeS3Key | Response> {
    const authorization = request.headers.get("authorization");
    if (authorization === null) return xmlError(403, "AccessDenied", "Access Denied");
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
        authorization.trim(),
      );
    if (match === null) {
      return xmlError(400, "AuthorizationHeaderMalformed", "The authorization header is malformed");
    }
    const [, accessKeyId, scope, signedHeaders, signature] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const pair = options.keys.find((candidate) => candidate.accessKeyId === accessKeyId);
    if (pair === undefined) {
      return xmlError(
        403,
        "InvalidAccessKeyId",
        "The Access Key Id you provided does not exist in our records.",
      );
    }
    if (verify) {
      const payloadHash = request.headers.get("x-amz-content-sha256") ?? sha256Hex(body);
      if (!signatureMatches(request, url, pair, scope, signedHeaders, signature, payloadHash)) {
        return xmlError(
          403,
          "SignatureDoesNotMatch",
          `The request signature we calculated does not match the signature you provided. String to sign: AWS4-HMAC-SHA256 ${accessKeyId}`,
        );
      }
    }
    return pair;
  }

  function denied(pair: FakeS3Key, key: string, write: boolean): boolean {
    if (write && pair.readOnly === true) return true;
    return (pair.denyPrefixes ?? []).some((prefix) => key.startsWith(prefix));
  }

  function list(bucket: Map<string, FakeS3Object>, name: string, query: URLSearchParams): Response {
    const prefix = query.get("prefix") ?? "";
    const delimiter = query.get("delimiter") ?? "";
    const maxKeys = Number(query.get("max-keys") ?? DEFAULT_MAX_KEYS);
    const token = query.get("continuation-token");
    const startAfter =
      token === null ? (query.get("start-after") ?? "") : Buffer.from(token, "base64").toString();
    const keys = [...bucket.keys()]
      .filter((key) => key.startsWith(prefix) && key > startAfter)
      .sort();
    const contents: string[] = [];
    const prefixes: string[] = [];
    let count = 0;
    let last = "";
    let truncated = false;
    let index = 0;
    while (index < keys.length) {
      if (count >= maxKeys) {
        truncated = true;
        break;
      }
      const key = keys[index] as string;
      const rest = key.slice(prefix.length);
      const cut = delimiter.length === 0 ? -1 : rest.indexOf(delimiter);
      if (cut >= 0) {
        const common = key.slice(0, prefix.length + cut + delimiter.length);
        prefixes.push(common);
        while (index < keys.length && (keys[index] as string).startsWith(common)) {
          last = keys[index] as string;
          index += 1;
        }
      } else {
        contents.push(key);
        last = key;
        index += 1;
      }
      count += 1;
    }
    const parts = [
      `<ListBucketResult ${XMLNS}>`,
      `<Name>${escapeXml(name)}</Name>`,
      `<Prefix>${escapeXml(prefix)}</Prefix>`,
      `<KeyCount>${count}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys>`,
      delimiter.length === 0 ? "" : `<Delimiter>${escapeXml(delimiter)}</Delimiter>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      truncated
        ? `<NextContinuationToken>${Buffer.from(last).toString("base64")}</NextContinuationToken>`
        : "",
    ];
    for (const key of contents) {
      const object = bucket.get(key) as FakeS3Object;
      parts.push(
        `<Contents><Key>${escapeXml(key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${escapeXml(object.etag)}</ETag><Size>${object.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      );
    }
    for (const common of prefixes) {
      parts.push(`<CommonPrefixes><Prefix>${escapeXml(common)}</Prefix></CommonPrefixes>`);
    }
    parts.push("</ListBucketResult>");
    return xml(200, parts.join(""));
  }

  function getObject(
    bucket: Map<string, FakeS3Object>,
    key: string,
    request: Request,
    withBody: boolean,
  ): Response {
    const object = bucket.get(key);
    if (object === undefined) {
      return withBody
        ? xmlError(404, "NoSuchKey", "The specified key does not exist.", `/${key}`)
        : new Response(null, { status: 404, headers: { "x-amz-request-id": randomUUID() } });
    }
    const ifMatch = request.headers.get("if-match");
    if (ifMatch !== null && ifMatch !== object.etag) {
      return xmlError(
        412,
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
      );
    }
    const ifUnmodified = request.headers.get("if-unmodified-since");
    if (ifUnmodified !== null) {
      const since = new Date(ifUnmodified);
      if (!Number.isNaN(since.getTime()) && object.lastModified.getTime() > since.getTime() + 999) {
        return xmlError(
          412,
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
        );
      }
    }
    const headers = objectHeaders(object);
    const rangeHeader = request.headers.get("range");
    if (rangeHeader !== null) {
      const range = parseRange(rangeHeader, object.bytes.byteLength);
      if (range === null) {
        return xmlError(416, "InvalidRange", "The requested range is not satisfiable");
      }
      const slice = object.bytes.subarray(range.start, range.end + 1);
      headers["content-range"] = `bytes ${range.start}-${range.end}/${object.bytes.byteLength}`;
      headers["content-length"] = String(slice.byteLength);
      return new Response(withBody ? slice : null, { status: 206, headers });
    }
    headers["content-length"] = String(object.bytes.byteLength);
    return new Response(withBody ? object.bytes : null, { status: 200, headers });
  }

  function putObject(
    bucket: Map<string, FakeS3Object>,
    key: string,
    request: Request,
    body: Uint8Array,
  ): Response {
    if (request.headers.get("if-none-match") === "*" && bucket.has(key)) {
      return xmlError(
        412,
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
      );
    }
    const object = store(
      bucket,
      key,
      body,
      request.headers.get("content-type") ?? "binary/octet-stream",
      metadataFrom(request.headers),
    );
    return new Response(null, {
      status: 200,
      headers: { etag: object.etag, "x-amz-request-id": randomUUID() },
    });
  }

  function copyObject(
    bucket: Map<string, FakeS3Object>,
    key: string,
    request: Request,
    pair: FakeS3Key,
  ): Response {
    const source = decodePathSegments(
      (request.headers.get("x-amz-copy-source") as string).replace(/^\//, ""),
    );
    const slash = source.indexOf("/");
    const sourceBucket = buckets.get(source.slice(0, slash));
    if (sourceBucket === undefined) {
      return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");
    }
    const sourceKey = source.slice(slash + 1);
    if (denied(pair, sourceKey, false)) return xmlError(403, "AccessDenied", "Access Denied");
    const existing = sourceBucket.get(sourceKey);
    if (existing === undefined) {
      return xmlError(404, "NoSuchKey", "The specified key does not exist.", `/${sourceKey}`);
    }
    const replace = request.headers.get("x-amz-metadata-directive") === "REPLACE";
    const object = store(
      bucket,
      key,
      existing.bytes,
      replace
        ? (request.headers.get("content-type") ?? existing.contentType)
        : existing.contentType,
      replace ? metadataFrom(request.headers) : { ...existing.metadata },
      existing.etag,
    );
    return xml(
      200,
      `<CopyObjectResult ${XMLNS}><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${escapeXml(object.etag)}</ETag></CopyObjectResult>`,
    );
  }

  function deleteObjects(
    bucket: Map<string, FakeS3Object>,
    body: Uint8Array,
    pair: FakeS3Key,
  ): Response {
    const text = new TextDecoder().decode(body);
    const quiet = /<Quiet>true<\/Quiet>/.test(text);
    const parts = [`<DeleteResult ${XMLNS}>`];
    for (const match of text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const key = unescapeXml(match[1] as string);
      if (denied(pair, key, true)) {
        parts.push(
          `<Error><Key>${escapeXml(key)}</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`,
        );
        continue;
      }
      bucket.delete(key);
      if (!quiet) parts.push(`<Deleted><Key>${escapeXml(key)}</Key></Deleted>`);
    }
    parts.push("</DeleteResult>");
    return xml(200, parts.join(""));
  }

  function createUpload(name: string, key: string, request: Request): Response {
    const uploadId = randomUUID();
    uploads.set(uploadId, {
      bucket: name,
      key,
      contentType: request.headers.get("content-type") ?? "binary/octet-stream",
      metadata: metadataFrom(request.headers),
      parts: new Map(),
    });
    return xml(
      200,
      `<InitiateMultipartUploadResult ${XMLNS}><Bucket>${escapeXml(name)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
    );
  }

  function uploadFor(uploadId: string, key: string): MultipartUpload | Response {
    const upload = uploads.get(uploadId);
    if (upload === undefined || upload.key !== key) {
      return xmlError(404, "NoSuchUpload", "The specified upload does not exist.");
    }
    return upload;
  }

  function uploadPart(
    uploadId: string,
    key: string,
    partNumber: number,
    body: Uint8Array,
  ): Response {
    const upload = uploadFor(uploadId, key);
    if (upload instanceof Response) return upload;
    upload.parts.set(partNumber, body);
    return new Response(null, {
      status: 200,
      headers: { etag: `"${md5Hex(body)}"`, "x-amz-request-id": randomUUID() },
    });
  }

  function completeUpload(
    bucket: Map<string, FakeS3Object>,
    name: string,
    uploadId: string,
    key: string,
    body: Uint8Array,
  ): Response {
    const upload = uploadFor(uploadId, key);
    if (upload instanceof Response) return upload;
    const text = new TextDecoder().decode(body);
    const numbers = [...text.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) =>
      Number(match[1]),
    );
    const chunks: Uint8Array[] = [];
    for (const number of numbers) {
      const part = upload.parts.get(number);
      if (part === undefined) {
        return xmlError(
          400,
          "InvalidPart",
          "One or more of the specified parts could not be found.",
        );
      }
      chunks.push(part);
    }
    const digests = concat(
      chunks.map((chunk) => new Uint8Array(createHash("md5").update(chunk).digest())),
    );
    const etag = `"${md5Hex(digests)}-${chunks.length}"`;
    store(bucket, key, concat(chunks), upload.contentType, upload.metadata, etag);
    uploads.delete(uploadId);
    return xml(
      200,
      `<CompleteMultipartUploadResult ${XMLNS}><Location>${escapeXml(`${origin}/${name}/${key}`)}</Location><Bucket>${escapeXml(name)}</Bucket><Key>${escapeXml(key)}</Key><ETag>${escapeXml(etag)}</ETag></CompleteMultipartUploadResult>`,
    );
  }

  function abortUpload(uploadId: string, key: string): Response {
    const upload = uploadFor(uploadId, key);
    if (upload instanceof Response) return upload;
    uploads.delete(uploadId);
    return new Response(null, { status: 204, headers: { "x-amz-request-id": randomUUID() } });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin) {
      throw new TypeError(`fetch failed: fake S3 answers ${origin}, not ${url.origin}`);
    }
    const segments = url.pathname.split("/");
    const name = String(segments[1]);
    const key = decodePathSegments(segments.slice(2).join("/"));
    const parsed: ParsedRequest = {
      method: request.method,
      bucket: name,
      key,
      query: url.searchParams,
    };
    const intercepted = options.intercept?.(request, parsed) ?? null;
    if (intercepted !== null) return intercepted;

    const body = new Uint8Array(await request.arrayBuffer());
    const bucket = buckets.get(name);
    if (bucket === undefined) {
      return xmlError(404, "NoSuchBucket", "The specified bucket does not exist", `/${name}`);
    }
    const pair = await authenticate(request, url, body);
    if (pair instanceof Response) return pair;
    const query = url.searchParams;
    const write = request.method !== "GET" && request.method !== "HEAD";
    // A listing is scoped by its prefix the way an object request is by its key.
    const scope = key.length === 0 ? (url.searchParams.get("prefix") ?? "") : key;
    if (denied(pair, scope, write)) {
      return xmlError(403, "AccessDenied", "Access Denied", `/${name}/${key}`);
    }

    if (key.length === 0) {
      if (request.method === "GET") return list(bucket, name, query);
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      if (request.method === "POST" && query.has("delete"))
        return deleteObjects(bucket, body, pair);
      return xmlError(
        405,
        "MethodNotAllowed",
        "The specified method is not allowed against this resource.",
      );
    }
    const uploadId = query.get("uploadId");
    switch (request.method) {
      case "GET":
        return getObject(bucket, key, request, true);
      case "HEAD":
        return getObject(bucket, key, request, false);
      case "PUT":
        if (uploadId !== null && query.has("partNumber")) {
          return uploadPart(uploadId, key, Number(query.get("partNumber")), body);
        }
        if (request.headers.has("x-amz-copy-source")) return copyObject(bucket, key, request, pair);
        return putObject(bucket, key, request, body);
      case "POST":
        if (query.has("uploads")) return createUpload(name, key, request);
        if (uploadId !== null) return completeUpload(bucket, name, uploadId, key, body);
        return xmlError(400, "InvalidRequest", "Unsupported POST");
      case "DELETE":
        if (uploadId !== null) return abortUpload(uploadId, key);
        bucket.delete(key);
        return new Response(null, { status: 204, headers: { "x-amz-request-id": randomUUID() } });
      default:
        return xmlError(
          405,
          "MethodNotAllowed",
          "The specified method is not allowed against this resource.",
        );
    }
  }

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, header) => {
      headers[header] = value;
    });
    requests.push({ method: request.method, url: request.url, headers });
    return handle(request);
  };

  return {
    fetch: fetchImpl,
    requests,
    objects(bucketName) {
      const bucket = buckets.get(bucketName);
      if (bucket === undefined) throw new Error(`fake S3: unknown bucket ${bucketName}`);
      return bucket;
    },
    put(bucketName, key, content, contentType = "application/octet-stream") {
      const bucket = buckets.get(bucketName);
      if (bucket === undefined) throw new Error(`fake S3: unknown bucket ${bucketName}`);
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      store(bucket, key, bytes, contentType, {});
    },
    pendingUploads: () => uploads.size,
  };
}
