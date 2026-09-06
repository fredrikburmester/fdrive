export type NewFileKind = "text" | "markdown";

const DEFAULT_NAME_BY_KIND: Readonly<Record<NewFileKind, string>> = {
  text: "Untitled.txt",
  markdown: "Untitled.md",
};

/** The suggested name pre-filled in the "new file" dialog for `kind`. */
export function defaultFileName(kind: NewFileKind): string {
  return DEFAULT_NAME_BY_KIND[kind];
}
