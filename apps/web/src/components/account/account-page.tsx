"use client";

import { PageHeader } from "@/components/shell/page-header";
import { ApiTokensCard } from "./api-tokens-card";
import { FolderViewsCard } from "./folder-views-card";
import { IdentitiesCard } from "./identities-card";

/** `/account`: identities and API tokens for the signed-in account. */
export function AccountPage() {
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">Account</span>} />
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        <IdentitiesCard />
        <FolderViewsCard />
        <ApiTokensCard />
      </div>
    </>
  );
}
