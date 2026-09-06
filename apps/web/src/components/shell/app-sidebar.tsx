"use client";

import { ChevronsUpDown, LogOut, Monitor, Moon, Settings2, Sun, UserRound } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { FolderTree } from "@/components/shell/folder-tree";
import { useShellMe } from "@/components/shell/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
} from "@/components/ui/sidebar";
import { useLogout } from "@/lib/api/auth-queries";

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

/** True when `pathname` is the System location or a path within it. */
export function isSystemRoute(pathname: string | null): boolean {
  return pathname === "/system" || (pathname?.startsWith("/system/") ?? false);
}

const SYSTEM_CONNECTION_ROUTE = "/system/connection" as Route;
const ACCOUNT_ROUTE = "/account" as Route;

export function AppSidebar() {
  const { data: me } = useShellMe();
  const { theme, setTheme } = useTheme();
  const logout = useLogout();
  const pathname = usePathname();

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
              <FolderTree />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {me?.isAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuButton
                  isActive={isSystemRoute(pathname)}
                  render={<Link href={SYSTEM_CONNECTION_ROUTE} />}
                >
                  <Settings2 />
                  <span>Connection</span>
                </SidebarMenuButton>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
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
            <DropdownMenuGroup>
              <DropdownMenuLabel>{activeIdentity?.username ?? "Account"}</DropdownMenuLabel>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Monitor />
                  Appearance
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={theme ?? "system"}
                    onValueChange={(value) => setTheme(value)}
                  >
                    {THEME_OPTIONS.map(({ value, label, Icon }) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        <Icon />
                        {label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href={ACCOUNT_ROUTE} />}>
                <UserRound />
                Account
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => logout.mutate()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
