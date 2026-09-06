import type { Metadata } from "next";
import { AccountPage } from "@/components/account/account-page";

export const metadata: Metadata = {
  title: "Account - fdrive",
};

export default function Account() {
  return <AccountPage />;
}
