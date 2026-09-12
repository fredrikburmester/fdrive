import type { ApiClient, MeResponse } from "@fdrive/contracts";
import { redirect } from "next/navigation";
import { cache } from "react";
import { serverApiClient } from "@/lib/api/server";

/**
 * Builds the server-side API client for the shell, redirecting to `/login`
 * immediately when the client itself cannot be built (an unreachable API).
 * Kept separate from the `about`/`me` calls below so `redirect`'s internal
 * control-flow exception is never accidentally caught by a `try`/`catch`
 * around those calls.
 */
async function loadClientOrRedirectToLogin(): Promise<ApiClient> {
  try {
    return await serverApiClient();
  } catch {
    redirect("/login");
  }
}

/**
 * Loads the signed-in account for the shell. Checks `/about` first and
 * sends the visitor to `/setup` when fdrive has not been configured yet;
 * otherwise loads `/auth/me`, redirecting to `/login` on any failure (an
 * `unauthorized`/`reauth_required` response, or the API being unreachable
 * entirely): without a known identity there is nothing safe to render
 * inside the shell.
 *
 * Wrapped in React's `cache` so the shell layout and the nested layouts
 * that gate on the account (`system/`) share one `/auth/me` round trip per
 * server render instead of each making their own.
 */
export const loadMe = cache(async (): Promise<MeResponse> => {
  const client = await loadClientOrRedirectToLogin();

  let setupRequired = false;
  try {
    setupRequired = (await client.about()).setupRequired;
  } catch {
    // Unreachable here: `client.me()` below will fail the same way and
    // redirect to `/login`, which is the right outcome when `/about`
    // itself cannot be reached.
  }
  if (setupRequired) {
    redirect("/setup");
  }

  try {
    return await client.me();
  } catch {
    redirect("/login");
  }
});
