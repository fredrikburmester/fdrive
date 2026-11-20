import { redirect } from "next/navigation";
import { SYSTEM_ROUTE } from "@/lib/system/areas";

/**
 * System had a Features page that listed every optional feature. Each feature is now turned on
 * and off in its own area, so an old link to the page lands on System itself.
 */
export default function SystemFeaturesPage(): never {
  redirect(SYSTEM_ROUTE);
}
