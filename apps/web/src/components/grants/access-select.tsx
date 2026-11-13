"use client";

import type { GrantAccess } from "@fdrive/contracts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GRANT_ACCESS_LABELS, GRANT_ACCESS_OPTIONS } from "@/lib/grants/format";
import { cn } from "@/lib/utils";

/** "Can view" or "Can edit" for one person on a shared folder. */
export function AccessSelect({
  value,
  onChange,
  label,
  disabled = false,
  className,
}: {
  value: GrantAccess;
  onChange: (access: GrantAccess) => void;
  /** The accessible name, e.g. "Access for grace". */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "read" || next === "write") onChange(next);
      }}
    >
      <SelectTrigger aria-label={label} size="sm" className={cn("w-28", className)}>
        <SelectValue>{GRANT_ACCESS_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {GRANT_ACCESS_OPTIONS.map((access) => (
          <SelectItem key={access} value={access}>
            {GRANT_ACCESS_LABELS[access]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
