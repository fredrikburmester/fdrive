import {
  type ApiClient,
  buildRequestUrl,
  createApiClient,
  ROUTES,
  ShareId,
  ShareUploadPath,
} from "@fdrive/contracts";

export type PublicShareClient = Pick<
  ApiClient,
  | "publicShare"
  | "setSharePassword"
  | "clearSharePassword"
  | "shareEntries"
  | "shareArchiveEntries"
  | "shareDownloadUrl"
  | "shareThumbUrl"
  | "shareArchiveUrl"
  | "shareUpload"
>;

/** Public requests deliberately use no authenticated tab client or identity headers. */
export function publicShareClient(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): PublicShareClient {
  return createApiClient({
    baseUrl: "",
    fetch: (url, init) =>
      fetchImpl(url, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        ...(signal ? { signal } : {}),
      }),
  });
}

export function publicUploadUrl(id: string, path: string): string {
  ShareId.parse(id);
  ShareUploadPath.parse(path);
  return buildRequestUrl("", `${ROUTES.publicShares}/${encodeURIComponent(id)}/upload`, { path });
}
