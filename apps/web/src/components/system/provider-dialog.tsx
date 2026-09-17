"use client";

import type {
  AdminProvider,
  AdminProviderType,
  ProviderField,
  ProviderType,
} from "@fdrive/contracts";
import { isHttpUrl } from "@fdrive/contracts";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { FilesOnlyNote } from "@/components/identity/files-only-note";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeApiError } from "@/lib/api/errors";
import {
  useAdminCreateProvider,
  useAdminTestProvider,
  useAdminUpdateProvider,
} from "@/lib/api/system-queries";
import {
  homeTemplatePreview,
  normalizeProviderConfig,
  providerAddressHint,
  providerAddressLock,
  providerConfigDraft,
  providerFormError,
  providerUpdatePatch,
} from "@/lib/system/connection";

export interface ProviderDialogProps {
  /** The provider being edited, or `null` to add a new one. */
  readonly provider: AdminProvider | null;
  /** The provider types this build can add, from `GET /admin/providers`. */
  readonly types: readonly AdminProviderType[];
  readonly onClose: () => void;
}

/**
 * The add and edit form for one storage provider. Both cases render the
 * same fields, generated from the selected type's `configFields`, so a
 * provider type that grows a setting needs no change here. The address is
 * read-only for a row the deployment pins or whose logins are already bound
 * to it, and saving an edit sends only the fields that changed.
 */
export function ProviderDialog({ provider, types, onClose }: ProviderDialogProps) {
  const editing = provider !== null;
  const initialType = provider?.type ?? types[0]?.type ?? "";
  const configFieldsOf = (candidate: string): readonly ProviderField[] =>
    types.find((entry) => entry.type === candidate)?.configFields ?? [];
  const [type, setType] = useState<string>(initialType);
  const fields = configFieldsOf(type);
  const addressHint = providerAddressHint(type);
  const [label, setLabel] = useState(provider?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [config, setConfig] = useState<Record<string, string>>(() =>
    providerConfigDraft(configFieldsOf(initialType), provider?.config),
  );
  const [touched, setTouched] = useState(false);
  const create = useAdminCreateProvider();
  const update = useAdminUpdateProvider();
  const test = useAdminTestProvider();

  const addressLock = provider === null ? null : providerAddressLock(provider);
  const draft = { label, baseUrl, config };
  const formError = providerFormError(fields, draft);
  const pending = create.isPending || update.isPending;
  const saveError = create.isError
    ? describeApiError(create.error)
    : update.isError
      ? describeApiError(update.error)
      : null;

  function changeType(next: string) {
    setType(next);
    setConfig(providerConfigDraft(configFieldsOf(next)));
    test.reset();
  }

  function submit() {
    if (formError !== null) {
      return;
    }
    if (provider === null) {
      const configuration = normalizeProviderConfig(config);
      create.mutate(
        {
          type: type as ProviderType,
          label: label.trim(),
          baseUrl: baseUrl.trim(),
          ...(Object.keys(configuration).length > 0 ? { config: configuration } : {}),
        },
        { onSuccess: onClose },
      );
      return;
    }
    const patch = providerUpdatePatch(provider, draft, addressLock === null);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    update.mutate({ id: provider.id, patch }, { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${provider.label}` : "Add provider"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Rename this server or change how it is configured."
              : "A storage server people can sign in to. Nothing is created on the server itself."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="provider-type">Type</FieldLabel>
            <Select
              items={types.map((candidate) => ({ value: candidate.type, label: candidate.label }))}
              value={type}
              onValueChange={(value) => changeType(value ?? type)}
              disabled={editing}
            >
              <SelectTrigger id="provider-type">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                {types.map((candidate) => (
                  <SelectItem key={candidate.type} value={candidate.type}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {editing ? (
              <FieldDescription>
                A provider's type cannot change after it is added.
              </FieldDescription>
            ) : null}
            <FilesOnlyNote
              capabilities={types.find((entry) => entry.type === type)?.capabilities}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-label">Name</FieldLabel>
            <Input
              id="provider-label"
              value={label}
              maxLength={120}
              required
              onChange={(event) => {
                setLabel(event.target.value);
                setTouched(true);
              }}
            />
            <FieldDescription>Shown when choosing storage and in Finder.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-address">Address</FieldLabel>
            <Input
              id="provider-address"
              value={baseUrl}
              required
              readOnly={addressLock !== null}
              disabled={addressLock !== null}
              placeholder={addressHint.example}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setTouched(true);
                test.reset();
              }}
            />
            <FieldDescription>{addressLock ?? addressHint.description}</FieldDescription>
          </Field>
          <ProviderFieldInputs
            fields={fields}
            values={config}
            idPrefix="provider-config"
            onChange={(name, value) => {
              setConfig({ ...config, [name]: value });
              setTouched(true);
            }}
          />
          {fields.some((field) => field.name === "homeTemplate") && config.homeTemplate ? (
            <FieldDescription>{homeTemplatePreview(config.homeTemplate, "")}</FieldDescription>
          ) : null}
          {editing ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isHttpUrl(baseUrl.trim()) || test.isPending}
                onClick={() =>
                  test.mutate({
                    type: type as ProviderType,
                    baseUrl: baseUrl.trim(),
                    config: normalizeProviderConfig(config),
                  })
                }
              >
                <RefreshCw className={test.isPending ? "animate-spin" : ""} />
                Test
              </Button>
              {test.data ? (
                <>
                  <Badge variant={test.data.ok ? "default" : "destructive"}>
                    {test.data.ok ? "Reachable" : "Unreachable"}
                  </Badge>
                  <span className="text-sm text-muted-foreground">{test.data.detail}</span>
                </>
              ) : null}
              {test.isError ? (
                <span className="text-sm text-destructive">{describeApiError(test.error)}</span>
              ) : null}
            </div>
          )}
          {formError === null || !touched ? null : <FieldError>{formError}</FieldError>}
          {saveError === null ? null : <FieldError>{saveError}</FieldError>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={formError !== null || pending} onClick={submit}>
            {editing ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
