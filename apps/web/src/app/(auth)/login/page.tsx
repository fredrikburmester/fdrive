import { serverApiClient } from "@/lib/api/server";
import { LoginForm } from "./login-form";

const DEFAULT_SUBTITLE = "Sign in with your SFTPGo account";

/**
 * Builds the login subtitle from the public `/about` endpoint's provider
 * label. Never throws: an unreachable API falls back to a generic subtitle
 * rather than breaking the login page.
 */
export async function resolveLoginSubtitle(
  getClient: typeof serverApiClient = serverApiClient,
): Promise<string> {
  try {
    const client = await getClient();
    const about = await client.about();
    return `Sign in with your SFTPGo account on ${about.provider.label}`;
  } catch {
    return DEFAULT_SUBTITLE;
  }
}

export default async function LoginPage() {
  const subtitle = await resolveLoginSubtitle();
  return <LoginForm subtitle={subtitle} />;
}
