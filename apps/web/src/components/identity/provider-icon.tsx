import type { ProviderType } from "@fdrive/contracts";
import { HardDrive, type LucideIcon, Server } from "lucide-react";
import { providerTypeLabel } from "@/lib/identity/provider-type";
import { cn } from "@/lib/utils";

const ICONS: Readonly<Record<ProviderType, LucideIcon>> = {
  sftpgo: Server,
};

export interface ProviderIconProps {
  readonly type: ProviderType;
  readonly className?: string;
}

/**
 * The icon for a provider type, next to a login's provider label in the
 * Logins card and the sidebar switcher. Labelled with the type's product
 * name so screen readers hear "SFTPGo" where sighted users see the glyph.
 */
export function ProviderIcon({ type, className }: ProviderIconProps) {
  const Icon = ICONS[type] ?? HardDrive;
  return (
    <Icon
      role="img"
      aria-label={providerTypeLabel(type)}
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}
