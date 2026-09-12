"use client";

import { ApiTokenAccess, type ApiTokenSummary, type IdentitySummary } from "@fdrive/contracts";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_EXPIRY_OPTION_VALUE,
  EXPIRY_OPTIONS,
  expiresInDaysFromOptionValue,
} from "@/lib/account/expiry";
import { useCreateApiToken } from "@/lib/account/queries";
import { describeApiError } from "@/lib/api/errors";

export interface CreateTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the freshly created token once, so the caller can show it. */
  onCreated: (result: { token: string; item: ApiTokenSummary }) => void;
  identities: Pick<IdentitySummary, "id" | "username" | "providerLabel" | "providerType">[];
  activeIdentityId: string;
}

export const TOKEN_ACCESS_LABELS = {
  read: "Read",
  organize: "Organize",
  full: "Full management",
} as const;
const ACCESS_HELP = {
  read: "Browse, read and search files.",
  organize: "Read, create folders, move, copy and tag files.",
  full: "Organize, create and edit files, and move items to and from Trash.",
};

/** Account page dialog: name a new API token and pick when it expires. */
export function CreateTokenDialog({
  open,
  onOpenChange,
  onCreated,
  identities,
  activeIdentityId,
}: CreateTokenDialogProps) {
  const [name, setName] = useState("");
  const [expiryValue, setExpiryValue] = useState(DEFAULT_EXPIRY_OPTION_VALUE);
  const createToken = useCreateApiToken();
  const [identityId, setIdentityId] = useState(activeIdentityId);
  const [mode, setMode] = useState<ApiTokenAccess["mode"]>("read");
  const [folders, setFolders] = useState("/");
  const [validationError, setValidationError] = useState<string | null>(null);
  const loginItems = identities.map((identity) => ({
    value: identity.id,
    label: `${identity.providerLabel || identity.providerType} · ${identity.username}`,
  }));

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setName("");
      setExpiryValue(DEFAULT_EXPIRY_OPTION_VALUE);
      createToken.reset();
    }
    onOpenChange(nextOpen);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length === 0 || createToken.isPending) {
      return;
    }
    const expiresInDays = expiresInDaysFromOptionValue(expiryValue);
    const access = ApiTokenAccess.safeParse({
      mode,
      paths: folders
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
    });
    if (!access.success || !identities.some((identity) => identity.id === identityId)) {
      setValidationError("Choose a login and enter 1–32 folder paths beginning with /.");
      return;
    }
    setValidationError(null);
    createToken.mutate(
      {
        name: name.trim(),
        identityId,
        access: access.data,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      },
      { onSuccess: (result) => onCreated(result) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>
              Used to connect Claude or Raycast. The token is shown once, right after you create it.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="token-name">Name</FieldLabel>
              <Input
                id="token-name"
                placeholder="Claude"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="token-login">Login</FieldLabel>
              <Select
                items={loginItems}
                value={identityId}
                onValueChange={(value) => {
                  if (value !== null) setIdentityId(value);
                }}
              >
                <SelectTrigger id="token-login">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {loginItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>The token can access only this storage login.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="token-access">Access</FieldLabel>
              <Select
                items={TOKEN_ACCESS_LABELS}
                value={mode}
                onValueChange={(value) => {
                  if (value !== null) setMode(value);
                }}
              >
                <SelectTrigger id="token-access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TOKEN_ACCESS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{ACCESS_HELP[mode]}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="token-folders">Allowed folders</FieldLabel>
              <Textarea
                id="token-folders"
                value={folders}
                onChange={(event) => setFolders(event.target.value)}
                rows={2}
              />
              <FieldDescription>
                One folder per line. / allows all folders in this login.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
              <Select
                items={EXPIRY_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                value={expiryValue}
                onValueChange={(value) => {
                  if (value !== null) {
                    setExpiryValue(value);
                  }
                }}
              >
                <SelectTrigger id="token-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {createToken.isError ? (
              <FieldError>{describeApiError(createToken.error)}</FieldError>
            ) : null}
            {validationError ? <FieldError>{validationError}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={name.trim().length === 0 || createToken.isPending}>
              {createToken.isPending ? "Creating…" : "Create token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
