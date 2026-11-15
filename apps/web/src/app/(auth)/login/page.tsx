import { CanonicalUuid } from "@fdrive/contracts";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { serverApiClient } from "@/lib/api/server";
import { LoginForm } from "./login-form";

/**
 * True when the public `/about` endpoint reports setup is still required,
 * in which case the login page sends the visitor to `/setup` instead:
 * there is no one to sign in as yet. Fails open to `false` (stay on the
 * login page) when the API cannot be reached at all.
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

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ desktopRequest?: string }>;
}) {
  if (await shouldRedirectToSetup()) {
    redirect("/setup");
  }
  const request = CanonicalUuid.safeParse((await searchParams).desktopRequest);
  const destination = request.success
    ? (`/desktop/connect?request=${request.data}` as Route)
    : undefined;
  return <LoginForm {...(destination ? { destination } : {})} />;
}
