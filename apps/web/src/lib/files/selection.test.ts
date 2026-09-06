import { describe, expect, it } from "vitest";
import {
  arrow,
  clear,
  click,
  EMPTY_SELECTION,
  reconcile,
  type SelectionState,
  selectAll,
  selectionReducer,
  set,
} from "./selection";

const order = ["/a", "/b", "/c", "/d"];

describe("click", () => {
  it("selects only the clicked path with a plain click", () => {
    const state = click(EMPTY_SELECTION, order, "/b");
    expect(state).toEqual({ anchor: "/b", focus: "/b", selected: new Set(["/b"]) });
  });

  it("replaces a previous selection with a plain click", () => {
    const first = click(EMPTY_SELECTION, order, "/a");
    const second = click(first, order, "/c");
    expect(second.selected).toEqual(new Set(["/c"]));
    expect(second.anchor).toBe("/c");
  });

  it("adds to the selection with a meta-click", () => {
    const first = click(EMPTY_SELECTION, order, "/a");
    const second = click(first, order, "/c", { meta: true });
    expect(second.selected).toEqual(new Set(["/a", "/c"]));
    expect(second.anchor).toBe("/c");
  });

  it("removes from the selection with a meta-click on a selected path", () => {
    const first = click(EMPTY_SELECTION, order, "/a", { meta: true });
    const second = click(first, order, "/a", { meta: true });
    expect(second.selected.size).toBe(0);
  });

  it("extends the range with a shift-click using the anchor", () => {
    const first = click(EMPTY_SELECTION, order, "/a");
    const second = click(first, order, "/c", { shift: true });
    expect(second.selected).toEqual(new Set(["/a", "/b", "/c"]));
    expect(second.anchor).toBe("/a");
    expect(second.focus).toBe("/c");
  });

  it("extends a reversed range with a shift-click", () => {
    const first = click(EMPTY_SELECTION, order, "/c");
    const second = click(first, order, "/a", { shift: true });
    expect(second.selected).toEqual(new Set(["/a", "/b", "/c"]));
  });

  it("shift-clicks with no prior anchor use the clicked path as the anchor", () => {
    const state = click(EMPTY_SELECTION, order, "/b", { shift: true });
    expect(state).toEqual({ anchor: "/b", focus: "/b", selected: new Set(["/b"]) });
  });

  it("falls back to a single-path range when the anchor is no longer in order", () => {
    const stale: SelectionState = { anchor: "/vanished", focus: "/vanished", selected: new Set() };
    const state = click(stale, order, "/b", { shift: true });
    expect(state.selected).toEqual(new Set(["/b"]));
  });
});

describe("arrow", () => {
  it("moves focus down from nothing to the first item", () => {
    const state = arrow(EMPTY_SELECTION, order, "down");
    expect(state).toEqual({ anchor: "/a", focus: "/a", selected: new Set(["/a"]) });
  });

  it("moves focus up from nothing to the last item", () => {
    const state = arrow(EMPTY_SELECTION, order, "up");
    expect(state).toEqual({ anchor: "/d", focus: "/d", selected: new Set(["/d"]) });
  });

  it("advances focus down by one, replacing the selection", () => {
    const first = click(EMPTY_SELECTION, order, "/a");
    const second = arrow(first, order, "down");
    expect(second).toEqual({ anchor: "/b", focus: "/b", selected: new Set(["/b"]) });
  });

  it("moves focus up by one", () => {
    const first = click(EMPTY_SELECTION, order, "/c");
    const second = arrow(first, order, "up");
    expect(second.focus).toBe("/b");
  });

  it("clamps at the last item when moving down", () => {
    const first = click(EMPTY_SELECTION, order, "/d");
    const second = arrow(first, order, "down");
    expect(second.focus).toBe("/d");
  });

  it("clamps at the first item when moving up", () => {
    const first = click(EMPTY_SELECTION, order, "/a");
    const second = arrow(first, order, "up");
    expect(second.focus).toBe("/a");
  });

  it("extends the selection with shift+down from an anchor", () => {
    const first = click(EMPTY_SELECTION, order, "/a");
    const second = arrow(first, order, "down", { shift: true });
    expect(second.selected).toEqual(new Set(["/a", "/b"]));
    expect(second.anchor).toBe("/a");
  });

  it("shift+arrow without a prior anchor uses the previous focus", () => {
    const stale: SelectionState = { anchor: null, focus: "/b", selected: new Set(["/b"]) };
    const state = arrow(stale, order, "down", { shift: true });
    expect(state.selected).toEqual(new Set(["/b", "/c"]));
    expect(state.anchor).toBe("/b");
  });

  it("returns the same state for an empty order", () => {
    const state = arrow(EMPTY_SELECTION, [], "down");
    expect(state).toBe(EMPTY_SELECTION);
  });
});

describe("selectAll", () => {
  it("selects every path and anchors at the ends", () => {
    const state = selectAll(order);
    expect(state.selected).toEqual(new Set(order));
    expect(state.anchor).toBe("/a");
    expect(state.focus).toBe("/d");
  });

  it("returns the empty selection for an empty order", () => {
    expect(selectAll([])).toEqual(EMPTY_SELECTION);
  });
});

describe("clear", () => {
  it("returns the empty selection", () => {
    expect(clear()).toEqual(EMPTY_SELECTION);
  });
});

describe("set", () => {
  it("replaces the selection with the given paths", () => {
    const state = set(["/b", "/c"]);
    expect(state).toEqual({ anchor: "/b", focus: "/c", selected: new Set(["/b", "/c"]) });
  });

  it("returns the empty selection for an empty list", () => {
    expect(set([])).toEqual(EMPTY_SELECTION);
  });
});

describe("reconcile", () => {
  it("drops selected paths that vanished", () => {
    const state: SelectionState = {
      anchor: "/a",
      focus: "/b",
      selected: new Set(["/a", "/b"]),
    };
    const next = reconcile(state, ["/a"]);
    expect(next.selected).toEqual(new Set(["/a"]));
    expect(next.anchor).toBe("/a");
    expect(next.focus).toBeNull();
  });

  it("returns the same reference when nothing changed", () => {
    const state: SelectionState = { anchor: "/a", focus: "/a", selected: new Set(["/a"]) };
    expect(reconcile(state, ["/a", "/b"])).toBe(state);
  });

  it("clears the anchor when it vanished", () => {
    const state: SelectionState = { anchor: "/gone", focus: null, selected: new Set() };
    const next = reconcile(state, ["/a"]);
    expect(next.anchor).toBeNull();
  });
});

describe("selectionReducer", () => {
  it("dispatches click", () => {
    const state = selectionReducer(EMPTY_SELECTION, { type: "click", path: "/b" }, order);
    expect(state.selected).toEqual(new Set(["/b"]));
  });

  it("dispatches click with modifiers", () => {
    const first = selectionReducer(EMPTY_SELECTION, { type: "click", path: "/a" }, order);
    const second = selectionReducer(
      first,
      { type: "click", path: "/c", modifiers: { shift: true } },
      order,
    );
    expect(second.selected).toEqual(new Set(["/a", "/b", "/c"]));
  });

  it("dispatches arrow", () => {
    const state = selectionReducer(EMPTY_SELECTION, { type: "arrow", direction: "down" }, order);
    expect(state.focus).toBe("/a");
  });

  it("dispatches selectAll", () => {
    const state = selectionReducer(EMPTY_SELECTION, { type: "selectAll" }, order);
    expect(state.selected).toEqual(new Set(order));
  });

  it("dispatches clear", () => {
    const first = selectionReducer(EMPTY_SELECTION, { type: "selectAll" }, order);
    const second = selectionReducer(first, { type: "clear" }, order);
    expect(second).toEqual(EMPTY_SELECTION);
  });

  it("dispatches set", () => {
    const state = selectionReducer(EMPTY_SELECTION, { type: "set", paths: ["/a", "/b"] }, order);
    expect(state.selected).toEqual(new Set(["/a", "/b"]));
  });

  it("dispatches reconcile", () => {
    const first = selectionReducer(EMPTY_SELECTION, { type: "selectAll" }, order);
    const second = selectionReducer(first, { type: "reconcile", paths: ["/a"] }, order);
    expect(second.selected).toEqual(new Set(["/a"]));
  });
});
