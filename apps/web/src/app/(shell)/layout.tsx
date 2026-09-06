import type { ApiClient, MeResponse } from "@fdrive/contracts";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { MeHydration } from "@/components/shell/me-hydration";
import { ShellRuntime } from "@/components/shell/shell-runtime";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { serverApiClient } from "@/lib/api/server";

/**
 * Builds the server-side API client for the shell layout, redirecting to
 * `/login` immediately when the client itself cannot be built (an
 * unreachable API). Kept separate from the `about`/`me` calls below so
 * `redirect`'s internal control-flow exception is never accidentally
 * caught by a `try`/`catch` around those calls.
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
 */
async function loadMe(): Promise<MeResponse> {
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
}

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await loadMe();

  return (
    <MeHydration me={me}>
      <ShellRuntime>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>{children}</SidebarInset>
        </SidebarProvider>
      </ShellRuntime>
    </MeHydration>
  );
}
