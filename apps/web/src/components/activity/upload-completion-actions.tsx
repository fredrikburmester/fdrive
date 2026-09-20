"use client";

import { parentPath } from "@fdrive/core";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { accountItemHref, identityLabel, navigateAccountItem } from "@/lib/account/identities";
import { useIdentityActions } from "@/lib/account/use-identities";
import { useMe } from "@/lib/api/auth-queries";
import type { UploadItem } from "@/lib/upload/types";

export function UploadCompletionActions({ item }: { item: UploadItem & { identityId: string } }) {
  const { data: me } = useMe();
  const identities = useIdentityActions();
  const router = useRouter();
  const linked = me?.identities.some((identity) => identity.id === item.identityId) ?? false;
  async function navigate(kind: "file" | "reveal") {
    if (!me) return;
    try {
      await navigateAccountItem(
        me,
        item.identityId,
        accountItemHref(kind, item.targetPath),
        identities.switch,
        (href) => router.push(href as Route),
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open this upload");
    }
  }
  return (
    <div className="min-w-0">
      <p className="break-all text-xs text-muted-foreground">
        {identityLabel(me?.identities ?? [], item.identityId)} · {parentPath(item.targetPath)}
      </p>
      <div className="flex flex-wrap gap-1">
        <Button
          className="min-h-11"
          variant="ghost"
          size="sm"
          disabled={!linked || identities.pending}
          onClick={() => void navigate("file")}
        >
          Open
        </Button>
        <Button
          className="min-h-11"
          variant="ghost"
          size="sm"
          disabled={!linked || identities.pending}
          onClick={() => void navigate("reveal")}
        >
          Show in folder
        </Button>
      </div>
      {!linked && <p className="text-xs text-muted-foreground">Login no longer linked</p>}
    </div>
  );
}
