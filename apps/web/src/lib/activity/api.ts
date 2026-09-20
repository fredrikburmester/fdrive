import {
  ActivityFileResponse,
  ActivityLocationsResponse,
  ApiError,
  type PersonalActivityFilters,
  PersonalActivityResponse,
} from "@fdrive/contracts";

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
    throw new Error(error.success ? error.data.error.message : "Could not load your activity");
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
export async function activityLocations() {
  return ActivityLocationsResponse.parse(await activityRequest("/locations")).items;
}
