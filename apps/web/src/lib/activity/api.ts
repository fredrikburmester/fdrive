import {
  ActivityFileResponse,
  ActivityLocationsResponse,
  ApiError,
  CanonicalUuid,
  type PersonalActivityFilters,
  PersonalActivityResponse,
} from "@fdrive/contracts";

/** A failed activity request, with the HTTP status so callers can tell "nothing recorded" apart. */
export class ActivityRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function activityRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/v1/activity${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "x-requested-with": "fdrive", "Content-Type": "application/json", ...init?.headers },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = ApiError.safeParse(value);
    throw new ActivityRequestError(
      error.success ? error.data.error.message : "Could not load your activity",
      response.status,
    );
  }
  return value;
}
export async function activityFeed(filters: Partial<PersonalActivityFilters>, scope = "") {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") query.set(key, String(value));
  return PersonalActivityResponse.parse(await activityRequest(`${scope}?${query}`));
}
export async function activityFile(id: string) {
  return ActivityFileResponse.parse(await activityRequest(`/files/${encodeURIComponent(id)}`));
}
/** The history ID recorded for a path of one login, or null while nothing has been recorded there. */
export async function resolveActivityFile(identityId: string, path: string) {
  try {
    const value = await activityRequest(
      `/files/resolve?${new URLSearchParams({ identityId, path })}`,
    );
    return CanonicalUuid.parse((value as { id?: unknown }).id);
  } catch (error) {
    if (error instanceof ActivityRequestError && error.status === 404) return null;
    throw error;
  }
}
export async function activityLocations() {
  return ActivityLocationsResponse.parse(await activityRequest("/locations")).items;
}
