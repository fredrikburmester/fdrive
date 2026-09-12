import { expect, it } from "vitest";
import { decideSave } from "./conflict";
import { discardDraft, draftKey, readDraft, writeDraft } from "./drafts";

it("restores unsaved text with its conflict baseline only for the same identity and path", () => {
  const key = draftKey("owner", "alice", "/draft.txt");
  const baseline = { text: "original", size: 8, modifiedAt: "2026-09-12T00:00:00Z" };
  writeDraft(key, { baseline, text: "edited" });
  const restored = readDraft(key);
  expect(restored?.text).toBe("edited");
  expect(readDraft(draftKey("new-owner", "alice", "/draft.txt"))).toBeUndefined();
  expect(readDraft(draftKey("owner", "bob", "/draft.txt"))).toBeUndefined();
  expect(readDraft(draftKey("owner", undefined, "/draft.txt"))).toBeUndefined();
  expect(readDraft(draftKey("owner", "alice", "/other.txt"))).toBeUndefined();
  if (!restored) throw new Error("missing draft");
  expect(decideSave(restored.baseline, { ...baseline, size: 9 })).toBe("conflict");
  discardDraft(key);
  expect(readDraft(key)).toBeUndefined();
  writeDraft(key, { baseline, text: "another edit" });
  writeDraft(key, { baseline, text: baseline.text });
  expect(readDraft(key)).toBeUndefined();
});
