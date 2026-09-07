import { ApiClientError } from "@fdrive/contracts";
import { describeApiError } from "@/lib/api/errors";

/** Admission conflicts mean another maintenance pass already owns the indexer. */
export function describeMaintenanceError(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 409) {
    return "A maintenance job is already running. Wait for it to finish, then try again.";
  }
  return describeApiError(error);
}
