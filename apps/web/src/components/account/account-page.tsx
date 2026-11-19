"use client";

import { PageHeader } from "@/components/shell/page-header";
import { ApiTokensCard } from "./api-tokens-card";
import { BrowsingCard } from "./browsing-card";
import { EncryptionCard } from "./encryption-card";
import { FolderViewsCard } from "./folder-views-card";
import { PasswordCard } from "./password-card";

/** `/account`: password, encryption, browsing preferences and API tokens for the signed-in account. */
export function AccountPage() {
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">Account</span>} />
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        <PasswordCard />
        <EncryptionCard />
        <FolderViewsCard />
        <BrowsingCard />
        <ApiTokensCard />
      </div>
    </>
  );
}
