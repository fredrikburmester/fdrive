import type { Metadata } from "next";
import { PasswordSection } from "@/components/account/password-section";

export const metadata: Metadata = {
  title: "Password - fdrive",
};

export default function SettingsPassword() {
  return <PasswordSection />;
}
