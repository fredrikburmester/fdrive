import type { Metadata } from "next";
import { GeneralPage } from "@/components/system/general-page";

export const metadata: Metadata = {
  title: "System - fdrive",
};

/**
 * `/system` itself: the first area on a wide screen. On a phone the frame shows the list of
 * areas here instead, and General opens at its own URL.
 */
export default function System() {
  return <GeneralPage />;
}
