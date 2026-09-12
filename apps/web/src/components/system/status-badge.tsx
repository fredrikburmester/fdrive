import { Badge } from "@/components/ui/badge";
import { type SidecarStatus, sidecarStatusLabel } from "@/lib/system/status";

const VARIANT_BY_STATUS: Record<SidecarStatus, "default" | "destructive" | "outline"> = {
  ok: "default",
  loading: "outline",
  unreachable: "destructive",
  not_configured: "outline",
};

/** Renders processing readiness, including model loading, as a coloured badge. */
export function StatusBadge({ status }: { status: SidecarStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{sidecarStatusLabel(status)}</Badge>;
}
