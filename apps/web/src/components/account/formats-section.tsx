"use client";

import { DetailSheet } from "@/components/shell/list-sheet";
import { ChoiceRow } from "@/components/shell/setting-controls";
import type { ClockFormat, DateStyle, SizeUnits } from "@/lib/format";
import { CLOCK_FORMATS, DATE_STYLES, SIZE_UNITS } from "@/lib/format-preferences";
import { useFormatPreferences } from "@/lib/use-format-preferences";

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

/** Settings > Formats: how listings write sizes, dates and times, kept in this browser. */
export function FormatsSection() {
  const [format, setFormat] = useFormatPreferences();
  return (
    <DetailSheet title="Formats" lede="How sizes, dates and times read in this browser.">
      <div data-slot="setting-rows">
        <ChoiceRow
          label="Sizes"
          hint={SIZE_HINTS[format.sizes]}
          value={format.sizes}
          options={SIZE_UNITS}
          labels={SIZE_LABELS}
          onChange={(value) => setFormat("sizes", value)}
        />
        <ChoiceRow
          label="Dates"
          hint={DATE_HINTS[format.dates]}
          value={format.dates}
          options={DATE_STYLES}
          labels={DATE_LABELS}
          onChange={(value) => setFormat("dates", value)}
        />
        <ChoiceRow
          label="Time"
          hint={CLOCK_HINTS[format.clock]}
          value={format.clock}
          options={CLOCK_FORMATS}
          labels={CLOCK_LABELS}
          onChange={(value) => setFormat("clock", value)}
        />
      </div>
    </DetailSheet>
  );
}
