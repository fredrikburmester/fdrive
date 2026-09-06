import type { MeResponse } from "@fdrive/contracts";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { serverApiClient } from "@/lib/api/server";

/**
 * Loads the signed-in account for the shell. Any failure (an
 * `unauthorized`/`reauth_required` response, or the API being unreachable
 * entirely) sends the visitor to `/login`: without a known identity there
 * is nothing safe to render inside the shell.
 */
async function loadMe(): Promise<MeResponse> {
  try {
    const client = await serverApiClient();
    return await client.me();
  } catch {
    redirect("/login");
  }
}

export default async function ShellLayout({ children }: { children: ReactNode }) {
  await loadMe();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
