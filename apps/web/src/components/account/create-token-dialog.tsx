"use client";

import type { ApiTokenSummary } from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
}

/** Account page dialog: name a new API token and pick when it expires. */
export function CreateTokenDialog({ open, onOpenChange, onCreated }: CreateTokenDialogProps) {
  const [name, setName] = useState("");
  const [expiryValue, setExpiryValue] = useState(DEFAULT_EXPIRY_OPTION_VALUE);
  const createToken = useCreateApiToken();

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setName("");
      setExpiryValue(DEFAULT_EXPIRY_OPTION_VALUE);
      createToken.reset();
    }
    onOpenChange(nextOpen);
  }

  function handleSubmit() {
    const expiresInDays = expiresInDaysFromOptionValue(expiryValue);
    createToken.mutate(
      { name: name.trim(), ...(expiresInDays !== undefined ? { expiresInDays } : {}) },
      { onSuccess: (result) => onCreated(result) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            Used to connect Claude or Raycast. The token is shown once, right after you create it.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
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
            <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
            <Select
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
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            disabled={name.trim().length === 0 || createToken.isPending}
            onClick={handleSubmit}
          >
            {createToken.isPending ? "Creating..." : "Create token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
