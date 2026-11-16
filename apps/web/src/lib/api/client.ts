import { createApiClient } from "@fdrive/contracts";

/** The browser's same-origin API client; the session cookie names the account and its login. */
export const apiClient = createApiClient({ baseUrl: "" });
