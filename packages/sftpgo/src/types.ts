export interface SftpgoClientOptions {
  /** e.g. http://sftpgo:8080. A trailing slash is tolerated and stripped. */
  baseUrl: string;
  /** Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Sent as the User-Agent header on every request. Defaults to "fdrive". */
  userAgent?: string;
  /** Per-request timeout in milliseconds for non-streaming calls. Defaults to 30000. */
  timeoutMs?: number;
}

export interface SftpgoToken {
  accessToken: string;
  expiresAt: Date;
}

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface SftpgoEntry {
  name: string;
  kind: EntryKind;
  size: number;
  modifiedAt: Date;
  mode: number;
}

export interface SftpgoFileStat {
  size: number;
  modifiedAt: Date | null;
  contentType: string | null;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface DownloadOptions {
  range?: ByteRange;
  ifRange?: string;
  signal?: AbortSignal;
}

export interface DownloadResult {
  status: 200 | 206;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  lastModified: Date | null;
}

export interface UploadOptions {
  mkdirParents?: boolean;
  modifiedAt?: Date;
  contentLength?: number;
  signal?: AbortSignal;
}

export interface SftpgoProfile {
  email: string;
  description: string;
  allowApiKeyAuth: boolean;
  publicKeys: string[];
}

export type ShareScope = "read" | "write";

export interface SftpgoShareInput {
  name: string;
  description?: string;
  scope: ShareScope;
  paths: string[];
  password?: string;
  expiresAt?: Date | null;
  maxTokens?: number;
  allowFrom?: string[];
}

export interface SftpgoShare {
  id: string;
  name: string;
  description: string;
  scope: ShareScope;
  paths: string[];
  username: string;
  createdAt: Date;
  updatedAt: Date;
  lastUseAt: Date | null;
  expiresAt: Date | null;
  maxTokens: number;
  usedTokens: number;
  allowFrom: string[];
  hasPassword: boolean;
}

export interface SftpgoUserShares {
  list(): Promise<SftpgoShare[]>;
  get(id: string): Promise<SftpgoShare>;
  create(input: SftpgoShareInput): Promise<{ id: string }>;
  update(id: string, input: SftpgoShareInput): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface SftpgoUserApi {
  list(path: string): Promise<SftpgoEntry[]>;
  statFile(path: string): Promise<SftpgoFileStat>;
  download(path: string, options?: DownloadOptions): Promise<DownloadResult>;
  upload(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: UploadOptions,
  ): Promise<void>;
  mkdir(path: string, options?: { parents?: boolean }): Promise<void>;
  move(path: string, target: string): Promise<void>;
  copy(path: string, target: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDir(path: string): Promise<void>;
  setModifiedAt(path: string, modifiedAt: Date): Promise<void>;
  zip(paths: readonly string[]): Promise<ReadableStream<Uint8Array>>;
  profile(): Promise<SftpgoProfile>;
  shares: SftpgoUserShares;
}

export interface SftpgoPublicShareApi {
  list(path?: string): Promise<SftpgoEntry[]>;
  download(path: string, options?: DownloadOptions): Promise<DownloadResult>;
  zip(): Promise<ReadableStream<Uint8Array>>;
  upload(
    fileName: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: { modifiedAt?: Date; contentLength?: number },
  ): Promise<void>;
}

export interface SftpgoClient {
  login(input: { username: string; password: string; otp?: string }): Promise<SftpgoToken>;
  logout(token: string): Promise<void>;
  user(token: string): SftpgoUserApi;
  publicShare(shareId: string, password?: string): SftpgoPublicShareApi;
}
