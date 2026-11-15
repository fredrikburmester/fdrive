import type { SaveBaseline } from "./conflict";

export interface EditorDraft {
  readonly baseline: SaveBaseline & { readonly text: string };
  readonly text: string;
}

/** Tab-local drafts survive App Router unmounts; account keys prevent cross-account restoration. */
const drafts = new Map<string, EditorDraft>();
export function draftKey(accountId: string | undefined, path: string): string {
  return JSON.stringify([accountId ?? null, path]);
}
export function readDraft(key: string): EditorDraft | undefined {
  return drafts.get(key);
}
export function writeDraft(key: string, draft: EditorDraft): void {
  if (draft.text === draft.baseline.text) drafts.delete(key);
  else drafts.set(key, draft);
}
export function discardDraft(key: string): void {
  drafts.delete(key);
}
