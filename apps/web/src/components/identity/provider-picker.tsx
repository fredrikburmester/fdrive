"use client";

import type { PublicProvider } from "@fdrive/contracts";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
 * form names it in its subtitle instead.
 */
export function ProviderPicker({ providers, value, onChange, id, disabled }: ProviderPickerProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Server</FieldLabel>
      <Select
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
              {provider.label}
              <span className="ml-1 text-muted-foreground text-xs">
                {providerTypeLabel(provider.type)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
