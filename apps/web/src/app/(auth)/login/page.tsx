import type { PublicProvider } from "@fdrive/contracts";
import { redirect } from "next/navigation";
import { serverApiClient } from "@/lib/api/server";
import { LoginForm } from "./login-form";

/**
 * Loads the enabled providers and their credential forms from the public
 * `/providers` endpoint. Never throws: an unreachable API returns no
 * providers, and the form then falls back to the SFTPGo-shaped default
 * fields and lets the server pick its only enabled provider, rather than
 * breaking the login page.
 */
export async function resolveLoginProviders(
  getClient: typeof serverApiClient = serverApiClient,
): Promise<PublicProvider[]> {
  try {
    const client = await getClient();
    return (await client.providers()).providers;
  } catch {
    return [];
  }
}

/**
 * True when the public `/about` endpoint reports setup is still required,
 * in which case the login page sends the visitor to `/setup` instead:
 * there is no storage provider to sign in against yet. Fails open to
 * `false` (stay on the login page) when the API cannot be reached at all,
 * matching `resolveLoginProviders`'s own fail-open behaviour.
 */
export async function shouldRedirectToSetup(
  getClient: typeof serverApiClient = serverApiClient,
): Promise<boolean> {
  try {
    const client = await getClient();
    const about = await client.about();
    return about.setupRequired;
  } catch {
    return false;
  }
}

export default async function LoginPage() {
  if (await shouldRedirectToSetup()) {
    redirect("/setup");
  }
  const providers = await resolveLoginProviders();
  return <LoginForm providers={providers} />;
}
