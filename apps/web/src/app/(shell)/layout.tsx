import type { ReactNode } from "react";
import { ChatPanel } from "@/components/ai/chat/chat-panel";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { MeHydration } from "@/components/shell/me-hydration";
import { ShellRuntime } from "@/components/shell/shell-runtime";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { loadMe } from "./load-me";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await loadMe();

  return (
    <MeHydration me={me}>
      <ShellRuntime>
        <SidebarProvider className="h-svh min-h-0 overflow-hidden">
          <AppSidebar />
          {/* Constrain the flex height so file virtualization measures the viewport.
              The inset retains vertical scrolling for longer settings pages. */}
          <SidebarInset className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
            {children}
          </SidebarInset>
          {/* Docked beside the page, not inside it, so it follows the person between folders and pages. */}
          <ChatPanel />
        </SidebarProvider>
      </ShellRuntime>
    </MeHydration>
  );
}
