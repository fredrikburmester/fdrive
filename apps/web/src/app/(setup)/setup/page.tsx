import type { Route } from "next";
import { redirect } from "next/navigation";
import { MeHydration } from "@/components/shell/me-hydration";
import { SetupFeatures } from "@/components/system/features-page";
import { SetupWizard } from "@/components/system/setup-wizard";
import { serverApiClient } from "@/lib/api/server";

/**
 * `/files` is served by an optional catch-all route
 * (`app/(shell)/files/[[...path]]`), which Next's typed routes only model
 * as `/files/${string}`, not the bare path; see the same escape hatch in
 * `lib/api/auth-queries.ts`.
 */
const FILES_ROUTE = "/files" as unknown as Route;

/**
 * Whether `/setup` should redirect to `/files`: true once fdrive is
 * already configured. Fails open (stays on `/setup`) when the API cannot
 * be reached at all, since that is exactly the state a fresh install is
 * in while the API container is still starting.
 */
export async function shouldRedirectToFiles(
  getClient: typeof serverApiClient = serverApiClient,
): Promise<boolean> {
  try {
    const client = await getClient();
    const about = await client.about();
    return !about.setupRequired;
  } catch {
    return false;
  }
}

export default async function SetupPage() {
  if (await shouldRedirectToFiles()) {
    let resume = null;
    try {
      const client = await serverApiClient();
      const me = await client.me();
      if (me.isAdmin) {
        resume = me;
        if ((await client.systemFeatures()).configuration.walkthroughComplete) resume = null;
      }
    } catch {
      // Keep an authenticated owner in setup when feature loading fails.
      // Without a session, the shell handles sign-in.
    }
    if (resume)
      return (
        <MeHydration me={resume}>
          <SetupFeatures />
        </MeHydration>
      );
    redirect(FILES_ROUTE);
  }
  return <SetupWizard />;
}
