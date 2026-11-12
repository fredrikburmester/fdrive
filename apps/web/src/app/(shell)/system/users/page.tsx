import type { Metadata } from "next";
import { UsersPage } from "@/components/system/users-page";

export const metadata: Metadata = {
  title: "Users - fdrive",
};

export default function SystemUsersPage() {
  return <UsersPage />;
}
