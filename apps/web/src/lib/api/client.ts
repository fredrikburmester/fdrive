import {
  type ApiClient,
  type ApiClientOptions,
  buildRequestUrl,
  createApiClient,
  IDENTITY_HEADER,
  ROUTES,
} from "@fdrive/contracts";

/** Each tab owns its selection; cookies only choose the initial login of a new tab. */
export function createTabApiClient(options: Omit<ApiClientOptions, "identityId"> = {}) {
  let identityId: string | undefined;
  function snapshot(): ApiClient {
    const owner = identityId;
    const client = createApiClient({
      ...options,
      ...(owner === undefined ? {} : { identityId: owner }),
    });
    return {
      ...client,
      thumbUrl: (path, size) =>
        buildRequestUrl(options.baseUrl ?? "", ROUTES.thumb, {
          path,
          size: String(size),
          identity: owner,
        }),
    };
  }
  const client = createApiClient({
    ...options,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      const path = String(url).split("?")[0];
      if (
        identityId !== undefined &&
        path !== `${options.baseUrl ?? ""}${ROUTES.auth.login}` &&
        path !== `${options.baseUrl ?? ""}${ROUTES.auth.logout}`
      )
        headers.set(IDENTITY_HEADER, identityId);
      const fetchImpl = options.fetch ?? globalThis.fetch;
      return fetchImpl(url, { ...init, headers });
    },
  });
  client.downloadUrl = (path, opts) => snapshot().downloadUrl(path, opts);
  client.thumbUrl = (path, size) => snapshot().thumbUrl(path, size);
  return {
    client,
    snapshot,
    getIdentity: () => identityId,
    pinIdentity: (id: string | undefined) => {
      identityId = id;
    },
  };
}

const tab = createTabApiClient({ baseUrl: "" });
export const apiClient = tab.client;

/** Browser-only state must never leak between server-rendered requests. */
export function pinTabIdentity(identityId: string | undefined): void {
  if (typeof window !== "undefined") tab.pinIdentity(identityId);
}

export function getTabIdentity(): string | undefined {
  return tab.getIdentity();
}

/** Capture before any asynchronous multi-request workflow starts. */
export function snapshotTabApiClient(): ApiClient {
  return tab.snapshot();
}

export function tabEventsUrl(): string {
  return buildRequestUrl("", ROUTES.events, { identity: tab.getIdentity() });
}
