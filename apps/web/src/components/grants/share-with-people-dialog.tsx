"use client";

import type { GrantAccess, OwnedGrant } from "@fdrive/contracts";
import { XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldDescription, FieldError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import {
  describeGrantError,
  GRANT_ACCESS_LABELS,
  grantsOnFolder,
  peopleToAdd,
} from "@/lib/grants/format";
import { useCreateGrant, useGrantPeople, useGrants } from "@/lib/grants/queries";
import { AccessSelect } from "./access-select";
import { useOwnedGrant } from "./use-owned-grant";

export interface ShareWithPeopleDialogProps {
  /** The folder being shared, one of the active login's own. */
  readonly folder: { readonly path: string; readonly name: string };
  readonly onClose: () => void;
}

/** One person who has the folder: their access, which can change, and a way to stop sharing. */
function GrantRow({ grant, folderName }: { grant: OwnedGrant; folderName: string }) {
  const { busy, changeAccess, stopSharing } = useOwnedGrant(grant, folderName);

  return (
    <li className="flex items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{grant.username}</span>
      <AccessSelect
        value={grant.access}
        label={`Access for ${grant.username}`}
        disabled={busy}
        onChange={changeAccess}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Stop sharing with ${grant.username}`}
        disabled={busy}
        onClick={stopSharing}
      >
        <XIcon />
      </Button>
    </li>
  );
}

/**
 * "Share with people": who else on this storage has a folder, what each of
 * them may do there, and a row to add someone. Each change applies at once;
 * the folder appears in their files under `Shared with me`.
 */
export function ShareWithPeopleDialog({ folder, onClose }: ShareWithPeopleDialogProps) {
  const grants = useGrants();
  const people = useGrantPeople();
  const create = useCreateGrant();
  const [person, setPerson] = useState<string | null>(null);
  const [access, setAccess] = useState<GrantAccess>("read");

  const current = grantsOnFolder(grants.data?.owned ?? [], folder.path);
  const candidates = peopleToAdd(people.data?.usernames ?? [], current);
  const chosen = person !== null && candidates.includes(person) ? person : null;

  function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen === null) return;
    create.mutate(
      { path: folder.path, username: chosen, access },
      {
        onSuccess: () => {
          toast.success(`Shared ${folder.name} with ${chosen}.`);
          setPerson(null);
        },
        onError: (error) => toast.error(describeGrantError(error)),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share {folder.name}</DialogTitle>
          <DialogDescription>
            People you add find it in their files under Shared with me.
          </DialogDescription>
        </DialogHeader>

        {grants.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : grants.isError ? (
          <FieldError>{describeApiError(grants.error)}</FieldError>
        ) : current.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
        ) : (
          <ul aria-label="People with access" className="divide-y">
            {current.map((grant) => (
              <GrantRow key={grant.id} grant={grant} folderName={folder.name} />
            ))}
          </ul>
        )}

        <form onSubmit={share} className="flex flex-col gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={chosen}
              disabled={candidates.length === 0 || create.isPending}
              onValueChange={(value) => setPerson(typeof value === "string" ? value : null)}
            >
              <SelectTrigger aria-label="Person" size="sm" className="min-w-0 flex-1">
                <SelectValue placeholder="Choose a person">{chosen}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {candidates.map((username) => (
                  <SelectItem key={username} value={username}>
                    {username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <AccessSelect
              value={access}
              label="Access for the new person"
              disabled={create.isPending}
              onChange={setAccess}
            />
            <Button type="submit" size="sm" disabled={chosen === null || create.isPending}>
              {create.isPending ? "Sharing…" : "Share"}
            </Button>
          </div>
          {people.isError ? (
            <FieldError>{describeApiError(people.error)}</FieldError>
          ) : people.data !== undefined && candidates.length === 0 ? (
            <FieldDescription>
              {people.data.usernames.length === 0
                ? "No one else has an account on this storage yet."
                : "Everyone with an account here already has this folder."}
            </FieldDescription>
          ) : (
            <FieldDescription>
              {GRANT_ACCESS_LABELS[access]}:{" "}
              {access === "write"
                ? "they can add, change and delete what is in it."
                : "they can open and download, not change."}
            </FieldDescription>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
