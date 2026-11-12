import type { ReactNode } from "react";
import { ChatPanel } from "@/components/ai/chat/chat-panel";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { MeHydration } from "@/components/shell/me-hydration";
import { ResizableSidebarProvider } from "@/components/shell/resizable-sidebar";
import { ShellRuntime } from "@/components/shell/shell-runtime";
import { SidebarInset } from "@/components/ui/sidebar";
import { loadMe } from "./load-me";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await loadMe();

  return (
    <MeHydration me={me}>
      <ShellRuntime>
        <ResizableSidebarProvider className="h-svh min-h-0 overflow-hidden">
          <AppSidebar />
          {/* Constrain the flex height so file virtualization measures the viewport.
              The inset retains vertical scrolling for longer settings pages. */}
          <SidebarInset className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
            {children}
          </SidebarInset>
          {/* In the live activity dock, outside the page, so it stays open between folders. */}
          <ChatPanel />
        </ResizableSidebarProvider>
      </ShellRuntime>
    </MeHydration>
  );
}
