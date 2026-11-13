"use client";

import type { GrantAccess, OwnedGrant } from "@fdrive/contracts";
import { toast } from "sonner";
import { describeGrantError } from "@/lib/grants/format";
import { useDeleteGrant, useUpdateGrant } from "@/lib/grants/queries";

/**
 * Changing or ending one person's access to a folder the active login
 * shares, with a toast either way. `folderName` names the folder in them.
 */
export function useOwnedGrant(grant: OwnedGrant, folderName: string) {
  const update = useUpdateGrant();
  const remove = useDeleteGrant();

  function changeAccess(access: GrantAccess) {
    if (access === grant.access) return;
    update.mutate(
      { id: grant.id, access },
      {
        onSuccess: () =>
          toast.success(
            `${grant.username} ${access === "write" ? "can now edit" : "can now only view"} ${folderName}.`,
          ),
        onError: (error) => toast.error(describeGrantError(error)),
      },
    );
  }

  function stopSharing() {
    remove.mutate(grant.id, {
      onSuccess: () => toast.success(`Stopped sharing ${folderName} with ${grant.username}.`),
      onError: (error) => toast.error(describeGrantError(error)),
    });
  }

  return { busy: update.isPending || remove.isPending, changeAccess, stopSharing };
}
