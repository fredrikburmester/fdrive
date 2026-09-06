/**
 * The fixed, Finder-like tag color palette: eight choices (seven hues plus
 * "no color"), each backed by a token defined in `globals.css`
 * (`--tag-<name>`, exposed as the Tailwind color `tag-<name>`). No other
 * colors are ever offered for a tag, so every tag in the app renders
 * consistently regardless of who created it.
 */
export const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;

export type TagHue = (typeof TAG_COLORS)[number];

/** A tag's color: one of the fixed hues, or "none" for an uncolored tag. */
export type TagColor = TagHue | "none";

export const TAG_COLOR_LABELS: Record<TagColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  gray: "Gray",
  none: "None",
};

const HUE_SET: ReadonlySet<string> = new Set(TAG_COLORS);

/**
 * Normalizes a tag's stored `color` (free-form in the database: `null`, an
 * unrecognized legacy value, or one of the fixed hues) into a `TagColor`,
 * falling back to "none" for anything that is not exactly one of the fixed
 * hues.
 */
export function normalizeTagColor(color: string | null | undefined): TagColor {
  if (color !== null && color !== undefined && HUE_SET.has(color)) {
    return color as TagColor;
  }
  return "none";
}

const DOT_CLASS_BY_COLOR: Record<TagColor, string> = {
  red: "bg-tag-red",
  orange: "bg-tag-orange",
  yellow: "bg-tag-yellow",
  green: "bg-tag-green",
  blue: "bg-tag-blue",
  purple: "bg-tag-purple",
  gray: "bg-tag-gray",
  none: "bg-transparent ring-1 ring-inset ring-border",
};

/** The Tailwind class(es) that paint a tag dot in `color`'s hue. */
export function tagDotClassName(color: string | null | undefined): string {
  return DOT_CLASS_BY_COLOR[normalizeTagColor(color)];
}
