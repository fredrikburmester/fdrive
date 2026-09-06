import { redirect } from "next/navigation";
import { serverApiClient } from "@/lib/api/server";
import { LoginForm } from "./login-form";

const DEFAULT_SUBTITLE = "Sign in with your SFTPGo account";

/**
 * Builds the login subtitle from the public `/about` endpoint's provider
 * label. Never throws: an unreachable API, or a `null` provider (setup not
 * completed yet), falls back to a generic subtitle rather than breaking
 * the login page.
 */
export async function resolveLoginSubtitle(
  getClient: typeof serverApiClient = serverApiClient,
): Promise<string> {
  try {
    const client = await getClient();
    const about = await client.about();
    if (about.provider === null) {
      return DEFAULT_SUBTITLE;
    }
    return `Sign in with your SFTPGo account on ${about.provider.label}`;
  } catch {
    return DEFAULT_SUBTITLE;
  }
}

/**
 * True when the public `/about` endpoint reports setup is still required,
 * in which case the login page sends the visitor to `/setup` instead:
 * there is no SFTPGo connection to sign in against yet. Fails open to
 * `false` (stay on the login page) when the API cannot be reached at all,
 * matching `resolveLoginSubtitle`'s own fail-open behaviour.
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
  const subtitle = await resolveLoginSubtitle();
  return <LoginForm subtitle={subtitle} />;
}
