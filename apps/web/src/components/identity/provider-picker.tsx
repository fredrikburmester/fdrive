"use client";

import type { PublicProvider } from "@fdrive/contracts";
import { FilesOnlyNote } from "@/components/identity/files-only-note";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providerDisplayName } from "@/lib/auth/login-model";
import { providerTypeLabel } from "@/lib/identity/provider-type";

export interface ProviderPickerProps {
  readonly providers: readonly PublicProvider[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly id: string;
  readonly disabled?: boolean;
}

/**
 * Chooses which storage server a credential form is for. Callers render
 * it only when more than one provider is enabled; with a single one the
 * form names it in its subtitle instead, and shows the files-only note
 * itself, which otherwise sits here under the choice it is about.
 */
export function ProviderPicker({ providers, value, onChange, id, disabled }: ProviderPickerProps) {
  const items = providers.map((provider) => ({
    value: provider.id,
    label: providerDisplayName(provider),
  }));
  return (
    <Field>
      <FieldLabel htmlFor={id}>Server</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a server" />
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => (
            <SelectItem key={provider.id} value={provider.id}>
              {providerDisplayName(provider)}
              {provider.label.length > 0 && (
                <span className="ml-1 text-muted-foreground text-xs">
                  {providerTypeLabel(provider.type)}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FilesOnlyNote
        capabilities={providers.find((provider) => provider.id === value)?.capabilities}
      />
    </Field>
  );
}
