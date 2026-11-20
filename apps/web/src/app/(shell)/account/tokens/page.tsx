import type { Metadata } from "next";
import { ApiTokensSection } from "@/components/account/api-tokens-section";

export const metadata: Metadata = {
  title: "API tokens - fdrive",
};

export default function SettingsApiTokens() {
  return <ApiTokensSection />;
}
