"use client";

import { ChevronsUpDown, Folder, LogOut, Monitor, Moon, Sun } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useShellMe } from "@/components/shell/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLogout } from "@/lib/api/auth-queries";

// `/files` is served by an optional catch-all route, which Next's typed
// routes only model as `/files/${string}`, not the bare path.
const FILES_ROUTE = "/files" as unknown as Route;

const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/** First two letters of `username`, upper-cased, for the avatar fallback. */
export function avatarInitials(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

/** True when `pathname` is the Files location or a path within it. */
export function isFilesRoute(pathname: string | null): boolean {
  return pathname === "/files" || (pathname?.startsWith("/files/") ?? false);
}

export function AppSidebar() {
  const pathname = usePathname();
  const { data: me } = useShellMe();
  const { theme, setTheme } = useTheme();
  const logout = useLogout();

  const activeIdentity = me?.identities.find((identity) => identity.id === me.activeIdentityId);

  return (
    <Sidebar className="border-r border-sidebar-border backdrop-blur-xl">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="text-base font-semibold tracking-tight">fdrive</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Locations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isFilesRoute(pathname)}
                  render={<Link href={FILES_ROUTE} />}
                >
                  <Folder />
                  <span>Files</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg">
                <Avatar className="size-6">
                  <AvatarFallback>
                    {activeIdentity ? avatarInitials(activeIdentity.username) : "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate text-sm font-medium">
                    {activeIdentity?.username ?? "..."}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {activeIdentity?.providerLabel ?? ""}
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <ToggleGroup
                value={[theme ?? "system"]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next !== undefined) {
                    setTheme(next);
                  }
                }}
                className="w-full"
              >
                {THEME_OPTIONS.map(({ value, label, Icon }) => (
                  <ToggleGroupItem key={value} value={value} aria-label={label} className="flex-1">
                    <Icon />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout.mutate()}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
