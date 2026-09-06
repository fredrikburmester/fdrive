import { describe, expect, it, vi } from "vitest";
import { type BeforeUnloadEventLike, guardBeforeUnload, isDirty } from "./dirty";

describe("isDirty", () => {
  it("is false when the document matches the baseline", () => {
    expect(isDirty("hello", "hello")).toBe(false);
  });

  it("is true when the document differs from the baseline", () => {
    expect(isDirty("hello", "hello!")).toBe(true);
  });
});

function fakeEvent(): BeforeUnloadEventLike {
  return { preventDefault: vi.fn(), returnValue: "" };
}

describe("guardBeforeUnload", () => {
  it("does nothing when not dirty", () => {
    const event = fakeEvent();
    guardBeforeUnload(event, false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBe("");
  });

  it("prevents the default and sets returnValue when dirty", () => {
    const event = fakeEvent();
    guardBeforeUnload(event, true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("");
  });
});
