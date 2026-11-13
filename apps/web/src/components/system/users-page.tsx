"use client";

import { type AdminUser, ApiClientError, LOCAL_PASSWORD_MIN_LENGTH } from "@fdrive/contracts";
import { MoreHorizontal, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatOptionalTimestamp, formatShortDate } from "@/lib/account/format";
import { describeApiError } from "@/lib/api/errors";
import {
  useAdminCreateUser,
  useAdminDeleteUser,
  useAdminUpdateUser,
  useAdminUsers,
} from "@/lib/api/system-queries";
import { localPasswordError, localUsernameError } from "@/lib/auth/local-account";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

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

interface UserRowProps {
  readonly user: AdminUser;
  readonly onResetPassword: (user: AdminUser) => void;
  readonly onRemove: (user: AdminUser) => void;
}

/** One user: name and badges, last sign-in, when they were added, and what can change. */
function UserRow({ user, onResetPassword, onRemove }: UserRowProps) {
  const update = useAdminUpdateUser();

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
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{user.username}</span>
          {user.isYou ? <Badge variant="outline">You</Badge> : null}
          {user.isAdmin ? (
            <Badge
              variant="secondary"
              title={
                user.adminByDeployment
                  ? "An administrator through FDRIVE_ADMIN_USERS in the deployment."
                  : undefined
              }
            >
              Admin
            </Badge>
          ) : null}
          {user.disabled ? <Badge variant="destructive">Disabled</Badge> : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatOptionalTimestamp(user.lastLoginAt, "Never")}
      </TableCell>
      <TableCell className="text-muted-foreground">{formatShortDate(user.createdAt)}</TableCell>
      <TableCell className="text-right">
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
                disabled={user.adminByDeployment}
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
      </TableCell>
    </TableRow>
  );
}

/**
 * Admin page: `System > Users`. The people who sign in to the deployment's
 * local folder, each with their own folder in it: add them, reset a
 * password, disable or enable, change the administrator flag, or remove
 * them. Their own row offers none of that to the administrator, as the API
 * refuses it; their password changes on the Account page. Without a local
 * folder there are no users here to manage.
 */
export function UsersPage() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useAdminUsers();
  const remove = useAdminDeleteUser();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const users = data?.users ?? [];
  const available = data?.available === true;
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
        <Button type="button" size="sm" disabled={!available} onClick={() => setAdding(true)}>
          <UserPlus />
          Add user
        </Button>
      }
    >
      {isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {forbidden ? (
        <SystemSection
          title="Administrators only"
          description="Users can only be viewed and managed by an administrator."
        />
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(error)}
        </p>
      ) : null}
      {data !== undefined && !available ? (
        <SystemSection
          title="No local folder"
          description="This installation serves no local folder, so it has no users of its own. People sign in with their accounts on the storage under System > Storage. Set FDRIVE_STORAGE_ROOT to serve a folder from this server."
        />
      ) : null}
      {available ? (
        <SystemSection
          title={users.length === 1 ? "1 user" : `${users.length} users`}
          description="Removing a user, resetting their password or disabling them signs them out everywhere."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <UserRow
                  key={user.username}
                  user={user}
                  onResetPassword={setResetting}
                  onRemove={setRemoving}
                />
              ))}
            </TableBody>
          </Table>
          {users.some((user) => user.isYou) ? (
            <p className="text-xs text-muted-foreground">
              You can't disable, demote or remove yourself. Change your own password on the Account
              page.
            </p>
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
