"use client";

import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface SegmentedControlProps<T extends string> {
  /** Names the group for assistive technology; the visible label sits beside it. */
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  /** An icon ahead of an option's label. */
  icons?: Partial<Record<T, LucideIcon>>;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * One choice out of a few, as a row of segments in a sunken well with the chosen one raised.
 * Exactly one segment is always pressed: pressing the chosen one again changes nothing.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  labels,
  icons,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      aria-label={label}
      spacing={1}
      value={[value]}
      onValueChange={(next: unknown[]) => {
        const chosen = options.find((option) => option === next[0]);
        if (chosen !== undefined) onChange(chosen);
      }}
      className={cn("max-w-full flex-wrap rounded-[10px] bg-well p-1", className)}
    >
      {options.map((option) => {
        const Icon: LucideIcon | undefined = icons?.[option];
        return (
          <ToggleGroupItem
            key={option}
            value={option}
            className="h-9 rounded-md px-3.5 font-medium text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-raised aria-pressed:text-foreground aria-pressed:shadow-segment"
          >
            {Icon !== undefined ? <Icon aria-hidden="true" /> : null}
            {labels[option]}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

export interface ChoiceRowProps<T extends string> extends SegmentedControlProps<T> {
  /** One line saying what the setting does, or what the current choice means. */
  hint: ReactNode;
}

/** A setting with a few fixed choices: its label and one-line hint beside a segmented control. */
export function ChoiceRow<T extends string>({ label, hint, ...control }: ChoiceRowProps<T>) {
  return (
    <SettingRow label={label} description={hint} align="end">
      <SegmentedControl label={label} {...control} />
    </SettingRow>
  );
}
