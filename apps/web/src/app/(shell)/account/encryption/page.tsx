import type { Metadata } from "next";
import { EncryptionSection } from "@/components/account/encryption-section";

export const metadata: Metadata = {
  title: "Encryption - fdrive",
};

export default function SettingsEncryption() {
  return <EncryptionSection />;
}
