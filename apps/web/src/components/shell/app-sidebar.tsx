"use client";

import {
  ChevronsUpDown,
  Clock3,
  Info,
  Link2,
  LogOut,
  Monitor,
  Moon,
  Sun,
  Trash2,
  UserRound,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { ProviderIcon } from "@/components/identity/provider-icon";
import { FavoritesSection } from "@/components/shell/favorites-section";
import { FolderTree } from "@/components/shell/folder-tree";
import { useShellMe } from "@/components/shell/page-header";
import { RecentsSection } from "@/components/shell/recents-section";
import { SystemNav } from "@/components/shell/system-nav";
import { TagsSection } from "@/components/shell/tags-section";
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
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useIdentityActions } from "@/lib/account/use-identities";
import { useLogout } from "@/lib/api/auth-queries";
import { anyLoginCan } from "@/lib/identity/capabilities";
import { loginDisplay } from "@/lib/identity/login-display";
import { SYSTEM_SCOPE_CAPTION } from "@/lib/system/pages";

const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/** First two letters of a login's title, upper-cased, for the avatar fallback. */
export function avatarInitials(title: string): string {
  return title.slice(0, 2).toUpperCase();
}

/** True when `pathname` is the Files location or a path within it. */
export function isFilesRoute(pathname: string | null): boolean {
  return pathname === "/files" || (pathname?.startsWith("/files/") ?? false);
}

/** True when `pathname` is the System location or a path within it. */
export function isSystemRoute(pathname: string | null): boolean {
  return pathname === "/system" || (pathname?.startsWith("/system/") ?? false);
}

/** True when `pathname` is the Trash location. */
export function isTrashRoute(pathname: string | null): boolean {
  return pathname === "/trash";
}

const TRASH_ROUTE = "/trash" as Route;
const ACCOUNT_ROUTE = "/account" as Route;

export function AppSidebar() {
  const { data: me } = useShellMe();
  const { theme, setTheme } = useTheme();
  const logout = useLogout();
  const identityActions = useIdentityActions();
  const pathname = usePathname();

  const activeIdentity = me?.identities.find((identity) => identity.id === me.activeIdentityId);
  const active = activeIdentity ? loginDisplay(activeIdentity) : undefined;

  return (
    <Sidebar className="border-r border-sidebar-border backdrop-blur-xl">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="text-base font-semibold tracking-tight">fdrive</span>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0 [&_[data-sidebar=group]]:py-1 [&_[data-sidebar=group-label]]:h-7 [&_[data-sidebar=menu]]:gap-0">
        <SidebarGroup>
          <SidebarGroupLabel>Locations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <FolderTree />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <FavoritesSection />
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname?.startsWith("/activity")}
                  render={<Link href={"/activity" as Route} />}
                >
                  <Clock3 />
                  <span>My activity</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <TagsSection />
        <RecentsSection />
        {/* Shares and Trash sit at the bottom of the navigation, above System. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {anyLoginCan(me, "shares") && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/shares"}
                    render={<Link href={"/shares" as Route} />}
                  >
                    <Link2 />
                    <span>Shares</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {anyLoginCan(me, "trash") && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={isTrashRoute(pathname)}
                    render={<Link href={TRASH_ROUTE} />}
                  >
                    <Trash2 />
                    <span>Trash</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {me?.isAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel>
              System
              <span className="ml-auto truncate font-normal text-sidebar-foreground/50">
                {SYSTEM_SCOPE_CAPTION}
              </span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SystemNav />
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
                  <AvatarFallback>{active ? avatarInitials(active.title) : "?"}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate text-sm font-medium">{active?.title ?? "..."}</span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    {activeIdentity && <ProviderIcon type={activeIdentity.providerType} />}
                    <span className="truncate">{active?.detail ?? ""}</span>
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Logins</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={me?.activeIdentityId ?? ""}
                onValueChange={(id) => {
                  if (id !== me?.activeIdentityId)
                    void identityActions
                      .switch(id)
                      .catch(() => toast.error("Could not switch login. Please try again."));
                }}
              >
                {me?.identities.map((identity) => {
                  const display = loginDisplay(identity);
                  return (
                    <DropdownMenuRadioItem
                      key={identity.id}
                      value={identity.id}
                      disabled={identityActions.pending}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{display.title}</span>
                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <ProviderIcon type={identity.providerType} />
                          <span className="truncate">{display.detail}</span>
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{active?.title ?? "Account"}</DropdownMenuLabel>
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
              <DropdownMenuItem render={<Link href={"/about" as Route} />}>
                <Info />
                About
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
