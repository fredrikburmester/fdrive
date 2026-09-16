"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROW_CLICK_ACTIONS, type RowClickAction } from "@/lib/files/row-click";
import { useRowClickAction } from "@/lib/files/use-row-click";
import type { ClockFormat, DateStyle, SizeUnits } from "@/lib/format";
import { CLOCK_FORMATS, DATE_STYLES, SIZE_UNITS } from "@/lib/format-preferences";
import { useFormatPreferences } from "@/lib/use-format-preferences";

const ROW_CLICK_LABELS: Record<RowClickAction, string> = {
  select: "Select",
  toggle: "Toggle selection",
  open: "Open",
};

const ROW_CLICK_HINTS: Record<RowClickAction, string> = {
  select: "A click selects just that item; double-click or Enter opens it.",
  toggle: "A click adds or removes the item from the selection, like its checkbox.",
  open: "A click opens the item; use the checkbox or Cmd/Ctrl-click to select.",
};

const SIZE_LABELS: Record<SizeUnits, string> = { binary: "Binary", decimal: "Decimal" };
const SIZE_HINTS: Record<SizeUnits, string> = {
  binary: "1,024 bytes per KB, as Windows counts.",
  decimal: "1,000 bytes per kB, as macOS counts.",
};

const DATE_LABELS: Record<DateStyle, string> = { relative: "Relative", absolute: "Absolute" };
const DATE_HINTS: Record<DateStyle, string> = {
  relative: "Recent changes read as Today or Yesterday with the time; older ones show the date.",
  absolute: "Every change shows its date and time.",
};

const CLOCK_LABELS: Record<ClockFormat, string> = { "24h": "24-hour", "12h": "12-hour" };
const CLOCK_HINTS: Record<ClockFormat, string> = {
  "24h": "Times read like 21:05.",
  "12h": "Times read like 9:05 PM.",
};

interface ChoiceFieldProps<T extends string> {
  label: string;
  hint: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}

/** A labelled row of toggle buttons with a one-line description of the current choice. */
function ChoiceField<T extends string>({
  label,
  hint,
  value,
  options,
  labels,
  onChange,
}: ChoiceFieldProps<T>) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <fieldset className="flex flex-wrap gap-2" aria-label={label}>
        {options.map((option) => (
          <Button
            key={option}
            variant={value === option ? "secondary" : "outline"}
            size="sm"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
          >
            {labels[option]}
          </Button>
        ))}
      </fieldset>
    </div>
  );
}

/** Per-browser preferences for how file listings respond to clicks and render sizes and dates. */
export function BrowsingCard() {
  const [rowClick, setRowClick] = useRowClickAction();
  const [format, setFormat] = useFormatPreferences();
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Browsing</CardTitle>
        <CardDescription>
          How listings respond to clicks and show sizes and dates in this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChoiceField
          label="Row click"
          hint={ROW_CLICK_HINTS[rowClick]}
          value={rowClick}
          options={ROW_CLICK_ACTIONS}
          labels={ROW_CLICK_LABELS}
          onChange={setRowClick}
        />
        <ChoiceField
          label="Sizes"
          hint={SIZE_HINTS[format.sizes]}
          value={format.sizes}
          options={SIZE_UNITS}
          labels={SIZE_LABELS}
          onChange={(value) => setFormat("sizes", value)}
        />
        <ChoiceField
          label="Dates"
          hint={DATE_HINTS[format.dates]}
          value={format.dates}
          options={DATE_STYLES}
          labels={DATE_LABELS}
          onChange={(value) => setFormat("dates", value)}
        />
        <ChoiceField
          label="Time"
          hint={CLOCK_HINTS[format.clock]}
          value={format.clock}
          options={CLOCK_FORMATS}
          labels={CLOCK_LABELS}
          onChange={(value) => setFormat("clock", value)}
        />
      </CardContent>
    </Card>
  );
}
