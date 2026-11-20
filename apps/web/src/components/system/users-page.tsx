"use client";

import { type AdminUser, ApiClientError, LOCAL_PASSWORD_MIN_LENGTH } from "@fdrive/contracts";
import { MoreHorizontal, ShieldAlert, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageEmpty,
} from "@/components/shell/page-layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatOptionalTimestamp, formatShortDate } from "@/lib/account/format";
import { describeApiError } from "@/lib/api/errors";
import {
  useAdminCreateUser,
  useAdminDeleteUser,
  useAdminUpdateUser,
  useAdminUsers,
} from "@/lib/api/system-queries";
import { localPasswordError, localUsernameError } from "@/lib/auth/local-account";
import { useFormatters } from "@/lib/use-format-preferences";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemNote, SystemSection } from "./system-section";

/** A user error as a sentence; a taken name gets its own, since the generic one says "refresh". */
function describeUserError(error: unknown): string {
  return error instanceof ApiClientError && error.kind === "conflict"
    ? "A user with this name already exists."
    : describeApiError(error);
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const error = value.length > 0 ? localPasswordError(value) : null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        maxLength={1024}
        value={value}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>At least {LOCAL_PASSWORD_MIN_LENGTH} characters.</FieldDescription>
      {error !== null ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/** Add user: a username (also their folder's name), a first password and the administrator flag. */
function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useAdminCreateUser();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const usernameError = username.length > 0 ? localUsernameError(username) : null;
  const ready = localUsernameError(username) === null && localPasswordError(password) === null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    const name = username.trim();
    create.mutate(
      { username: name, password, isAdmin },
      {
        onSuccess: () => {
          toast.success(`Added ${name}.`);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              They sign in with this username and password and get their own folder.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="user-username">Username</FieldLabel>
              <Input
                id="user-username"
                autoComplete="off"
                autoFocus
                maxLength={255}
                value={username}
                disabled={create.isPending}
                aria-invalid={usernameError !== null}
                onChange={(event) => setUsername(event.target.value)}
              />
              <FieldDescription>Also the name of their folder on this server.</FieldDescription>
              {usernameError !== null ? <FieldError>{usernameError}</FieldError> : null}
            </Field>
            <PasswordField
              id="user-password"
              label="Password"
              value={password}
              disabled={create.isPending}
              onChange={setPassword}
            />
            <Field orientation="horizontal">
              <FieldLabel htmlFor="user-admin">Administrator</FieldLabel>
              <Switch
                id="user-admin"
                checked={isAdmin}
                disabled={create.isPending}
                onCheckedChange={setIsAdmin}
              />
            </Field>
            <FieldDescription>Administrators manage fdrive under System.</FieldDescription>
            {create.isError ? <FieldError>{describeUserError(create.error)}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? "Adding…" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Reset password: the administrator sets a new one, which signs the user out everywhere. */
function ResetPasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const update = useAdminUpdateUser();
  const [password, setPassword] = useState("");
  const ready = localPasswordError(password) === null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    update.mutate(
      { username: user.username, patch: { password } },
      {
        onSuccess: () => {
          toast.success(`Changed the password of ${user.username}.`);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Reset password for {user.username}</DialogTitle>
            <DialogDescription>
              They are signed out everywhere and sign in again with the new password.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <PasswordField
              id="user-new-password"
              label="New password"
              value={password}
              disabled={update.isPending}
              onChange={setPassword}
            />
            {update.isError ? <FieldError>{describeUserError(update.error)}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || update.isPending}>
              {update.isPending ? "Saving…" : "Reset password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Storage limit: the most a user's folder may hold, typed in GB; empty for none. */
function StorageLimitDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const update = useAdminUpdateUser();
  const { prefs } = useFormatters();
  // GB as the size preference counts it, so the limit reads back as typed.
  const gb = prefs.sizes === "decimal" ? 1000 ** 3 : 1024 ** 3;
  const [value, setValue] = useState(
    user.storageLimit === null ? "" : String(Number((user.storageLimit / gb).toFixed(3))),
  );
  const bytes = value.trim() === "" ? null : Math.round(Number(value) * gb);
  const invalid = bytes !== null && !(Number.isSafeInteger(bytes) && bytes > 0);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) return;
    update.mutate(
      { username: user.username, patch: { storageLimit: bytes } },
      {
        onSuccess: () => {
          toast.success(
            bytes === null
              ? `${user.username} has no storage limit.`
              : `Set the storage limit of ${user.username}.`,
          );
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Storage limit for {user.username}</DialogTitle>
            <DialogDescription>
              Uploads and copies that would take their folder over it are refused.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="user-storage-limit">Limit in GB</FieldLabel>
              <Input
                id="user-storage-limit"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="No limit"
                autoFocus
                value={value}
                disabled={update.isPending}
                aria-invalid={invalid}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>Leave empty for no limit.</FieldDescription>
              {invalid ? <FieldError>Enter a size above zero.</FieldError> : null}
            </Field>
            {update.isError ? <FieldError>{describeUserError(update.error)}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface UserRowProps {
  readonly user: AdminUser;
  readonly onResetPassword: (user: AdminUser) => void;
  readonly onStorageLimit: (user: AdminUser) => void;
  readonly onRemove: (user: AdminUser) => void;
}

/** One user: name and badges, storage, last sign-in, when they were added, and what can change. */
function UserRow({ user, onResetPassword, onStorageLimit, onRemove }: UserRowProps) {
  const update = useAdminUpdateUser();
  const { formatBytes } = useFormatters();

  function change(patch: { disabled?: boolean; isAdmin?: boolean }, done: string) {
    update.mutate(
      { username: user.username, patch },
      {
        onSuccess: () => toast.success(done),
        onError: (error) => toast.error(describeUserError(error)),
      },
    );
  }

  return (
    <DataTableRow>
      <DataTableCell className="@max-xl:whitespace-normal">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{user.username}</span>
          {user.isYou ? <Badge variant="outline">You</Badge> : null}
          {user.isAdmin ? <Badge variant="secondary">Admin</Badge> : null}
          {user.disabled ? <Badge variant="destructive">Disabled</Badge> : null}
        </div>
      </DataTableCell>
      <DataTableCell className="text-muted-foreground tabular-nums @max-xl:whitespace-normal">
        {user.storageUsed === null ? "Not indexed" : formatBytes(user.storageUsed)}
        {user.storageLimit === null ? null : ` of ${formatBytes(user.storageLimit)}`}
      </DataTableCell>
      <DataTableCell className="text-muted-foreground @max-xl:hidden">
        {formatOptionalTimestamp(user.lastLoginAt, "Never")}
      </DataTableCell>
      <DataTableCell className="text-muted-foreground @max-xl:hidden">
        {formatShortDate(user.createdAt)}
      </DataTableCell>
      <DataTableCell className="text-right">
        {user.isYou ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${user.username}`}
                  disabled={update.isPending}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onResetPassword(user)}>
                Reset password
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onStorageLimit(user)}>
                Storage limit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  change(
                    { disabled: !user.disabled },
                    user.disabled
                      ? `${user.username} can sign in again.`
                      : `Disabled ${user.username} and signed them out.`,
                  )
                }
              >
                {user.disabled ? "Enable" : "Disable"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  change(
                    { isAdmin: !user.isAdmin },
                    user.isAdmin
                      ? `${user.username} is no longer an administrator.`
                      : `${user.username} is now an administrator.`,
                  )
                }
              >
                {user.isAdmin ? "Remove administrator" : "Make administrator"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onRemove(user)}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </DataTableCell>
    </DataTableRow>
  );
}

/**
 * Admin page: `System > Users`. The people who sign in to the deployment's
 * local folder, each with their own folder in it and what it holds: add
 * them, reset a password, set a storage limit, disable or enable, change the
 * administrator flag, or remove them. Their own row offers none of that to
 * the administrator, as the API refuses most of it; their password changes
 * in Settings.
 */
export function UsersPage() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useAdminUsers();
  const remove = useAdminDeleteUser();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [limiting, setLimiting] = useState<AdminUser | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const users = data?.users ?? [];
  // A non-administrator's session gets 403: a refusal, not an empty list.
  const forbidden = error instanceof ApiClientError && error.kind === "forbidden";

  function confirmRemove() {
    if (removing === null) return;
    const { username } = removing;
    remove.mutate(username, {
      onSuccess: () => toast.success(`Removed ${username}. Their files stay in their folder.`),
      onError: (cause) => toast.error(describeUserError(cause)),
    });
    setRemoving(null);
  }

  return (
    <SystemPage
      title="Users"
      description="People who sign in to this server's local folder, each with a folder of their own."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <Button
          type="button"
          size="sm"
          disabled={data === undefined}
          onClick={() => setAdding(true)}
        >
          <UserPlus />
          Add user
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : null}
      {forbidden ? (
        <PageEmpty
          icon={ShieldAlert}
          title="Administrators only"
          description="Users can only be viewed and managed by an administrator."
        />
      ) : isError ? (
        <SystemAlert row>{describeApiError(error)}</SystemAlert>
      ) : null}
      {data !== undefined ? (
        <SystemSection
          title={users.length === 1 ? "1 user" : `${users.length} users`}
          description="Removing a user, resetting their password or disabling them signs them out everywhere."
        >
          <DataTable>
            <DataTableHeader>
              <DataTableRow>
                <DataTableHead>Username</DataTableHead>
                <DataTableHead>Storage</DataTableHead>
                <DataTableHead className="@max-xl:hidden">Last sign-in</DataTableHead>
                <DataTableHead className="@max-xl:hidden">Added</DataTableHead>
                <DataTableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </DataTableHead>
              </DataTableRow>
            </DataTableHeader>
            <DataTableBody>
              {users.map((user) => (
                <UserRow
                  key={user.username}
                  user={user}
                  onResetPassword={setResetting}
                  onStorageLimit={setLimiting}
                  onRemove={setRemoving}
                />
              ))}
            </DataTableBody>
          </DataTable>
          {users.some((user) => user.isYou) ? (
            <SystemNote className="border-border/60 border-t">
              <p>
                You can't disable, demote or remove yourself. Change your own password in Settings.
              </p>
            </SystemNote>
          ) : null}
        </SystemSection>
      ) : null}

      {adding ? <AddUserDialog open onClose={() => setAdding(false)} /> : null}
      {resetting === null ? null : (
        <ResetPasswordDialog
          key={resetting.username}
          user={resetting}
          onClose={() => setResetting(null)}
        />
      )}
      {limiting === null ? null : (
        <StorageLimitDialog
          key={limiting.username}
          user={limiting}
          onClose={() => setLimiting(null)}
        />
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        {/* Keep the confirmation copy stable while the dialog exits. */}
        {removing && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {removing.username}?</AlertDialogTitle>
              <AlertDialogDescription>
                They are signed out everywhere and can no longer sign in. Their files stay in their
                folder on this server, and adding {removing.username} again restores their access.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmRemove}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </SystemPage>
  );
}
