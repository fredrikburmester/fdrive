// @vitest-environment jsdom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadLanguageExtension: vi.fn() }));
vi.mock("@/lib/editor/language", () => ({
  loadLanguageExtension: (...args: unknown[]) => mocks.loadLanguageExtension(...args),
}));

const { CodeMirrorEditor } = await import("./codemirror-editor");

const TEXT = "first line\nsecond line";

/** Resolvers for every `loadLanguageExtension` call still in flight, in call order. */
let pendingLoads: Array<(extension: Extension[]) => void> = [];

beforeEach(() => {
  pendingLoads = [];
  mocks.loadLanguageExtension.mockImplementation(
    () =>
      new Promise<Extension[]>((resolve) => {
        pendingLoads.push(resolve);
      }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function editorElement(token: number, text: string = TEXT) {
  return (
    <CodeMirrorEditor
      resetSignal={{ text, token }}
      languageKey="json"
      wordWrap={false}
      onChange={() => {}}
      onCursorChange={() => {}}
    />
  );
}

/** The live `EditorView` CodeMirror mounted into the component's container. */
function mountedView(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>(".cm-editor");
  if (dom === null) {
    throw new Error("CodeMirror did not mount an editor into the container");
  }
  const view = EditorView.findFromDOM(dom);
  if (view === null) {
    throw new Error("mounted DOM is not backed by an EditorView");
  }
  return view;
}

/** Lets the resolved language-import promises run their `.then` callbacks. */
async function flushLoads(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function resolveLoad(index: number, extension: Extension[]): void {
  const resolve = pendingLoads[index];
  if (resolve === undefined) {
    throw new Error(`no pending language load at index ${index}`);
  }
  resolve(extension);
}

it("reconfigures the mounted view once the language extension resolves", async () => {
  const { container } = render(editorElement(1));
  const view = mountedView(container);

  expect(view.state.doc.toString()).toBe(TEXT);
  // `tabSize` stands in for real language support: an observable facet the
  // loaded extension sets, so the assertion sees the state, not the call.
  expect(view.state.tabSize).toBe(4);

  for (let index = 0; index < pendingLoads.length; index += 1) {
    resolveLoad(index, [EditorState.tabSize.of(7)]);
  }
  await flushLoads();

  expect(view.state.tabSize).toBe(7);
});

it("does not dispatch to the destroyed view when the language import resolves after unmount", async () => {
  const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
  const { container, unmount } = render(editorElement(1));
  const view = mountedView(container);
  expect(pendingLoads.length).toBeGreaterThan(0);

  unmount();
  dispatch.mockClear();
  for (let index = 0; index < pendingLoads.length; index += 1) {
    resolveLoad(index, [EditorState.tabSize.of(7)]);
  }
  await flushLoads();

  expect(dispatch).not.toHaveBeenCalled();
  // A destroyed view swallows the update instead of throwing, so the stale
  // state swap is the only other trace the unguarded dispatch left behind.
  expect(view.state.tabSize).toBe(4);
});

it("leaves a view replaced by a reset alone and reconfigures the fresh one", async () => {
  const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
  const { container, rerender } = render(editorElement(1));
  const firstView = mountedView(container);
  const loadsBeforeReset = pendingLoads.length;

  rerender(editorElement(2, "reset text"));
  const secondView = mountedView(container);
  expect(secondView).not.toBe(firstView);

  // Index 0 is the replaced view's own mount-effect load. The language-change
  // effect's load (index 1) is deliberately left pending: its guard only
  // clears on unmount or a language change, which a reset is not, and that
  // effect is out of scope here.
  dispatch.mockClear();
  resolveLoad(0, [EditorState.tabSize.of(7)]);
  await flushLoads();

  expect(dispatch).not.toHaveBeenCalled();
  expect(firstView.state.tabSize).toBe(4);

  for (let index = loadsBeforeReset; index < pendingLoads.length; index += 1) {
    resolveLoad(index, [EditorState.tabSize.of(9)]);
  }
  await flushLoads();

  expect(secondView.state.doc.toString()).toBe("reset text");
  expect(secondView.state.tabSize).toBe(9);
});
