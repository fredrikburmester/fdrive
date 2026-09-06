export interface NameSelection {
  readonly base: string;
  readonly ext: string;
}

/**
 * Splits `name` into a base and extension so a rename dialog can
 * pre-select just the base, matching Finder's rename behavior. Dotfiles
 * (a leading dot with no other dot) and names ending in a bare dot have no
 * extension.
 */
export function splitNameForSelection(name: string): NameSelection {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return { base: name, ext: "" };
  }
  return { base: name.slice(0, lastDot), ext: name.slice(lastDot) };
}
