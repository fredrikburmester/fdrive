import { StatusBadge as Badge, type StatusTone } from "@/components/shell/status";
import { type SidecarStatus, sidecarStatusLabel } from "@/lib/system/status";

const TONE_BY_STATUS: Record<SidecarStatus, StatusTone> = {
  ok: "success",
  loading: "warning",
  unreachable: "danger",
  not_configured: "off",
};

/** A sidecar's readiness as a status badge: Reachable, Loading, Unreachable or Not configured. */
export function StatusBadge({ status }: { status: SidecarStatus }) {
  return <Badge tone={TONE_BY_STATUS[status]}>{sidecarStatusLabel(status)}</Badge>;
}
