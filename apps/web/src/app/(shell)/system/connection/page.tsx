import type { Metadata } from "next";
import { ConnectionPage } from "@/components/system/connection-page";

export const metadata: Metadata = {
  title: "Connection - fdrive",
};

export default function SystemConnectionPage() {
  return <ConnectionPage />;
}
