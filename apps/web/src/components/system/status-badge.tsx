import { Badge } from "@/components/ui/badge";
import { type SidecarStatus, sidecarStatusLabel } from "@/lib/system/status";

const VARIANT_BY_STATUS: Record<SidecarStatus, "default" | "destructive" | "outline"> = {
  ok: "default",
  unreachable: "destructive",
  not_configured: "outline",
};

/** Renders one of "Reachable" / "Unreachable" / "Not configured" as a coloured badge. */
export function StatusBadge({ status }: { status: SidecarStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{sidecarStatusLabel(status)}</Badge>;
}
