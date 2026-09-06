"use client";

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { type LanguageKey, loadLanguageExtension } from "@/lib/editor/language";
import { editorThemeSpec } from "@/lib/editor/theme";

export interface EditorResetSignal {
  /** The document text to reset the editor to. */
  readonly text: string;
  /** Bumped every time `text` should be applied, even if it repeats a
   * previous value (for example reverting twice to the same baseline). */
  readonly token: number;
}

export interface CodeMirrorEditorProps {
  readonly resetSignal: EditorResetSignal;
  readonly languageKey: LanguageKey;
  readonly wordWrap: boolean;
  readonly onChange: (text: string) => void;
  readonly onCursorChange: (offset: number) => void;
  readonly className?: string;
}

const theme = EditorView.theme(editorThemeSpec());

function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    keymap.of([
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    theme,
  ];
}

/**
 * A thin wrapper around a CodeMirror 6 `EditorView`: all editing behavior
 * (history, search, bracket closing, indentation) is CodeMirror's own, and
 * all styling comes from `editorThemeSpec` (`lib/editor/theme.ts`, unit
 * tested). This component only wires CodeMirror's imperative API to React
 * props: language and word-wrap are reconfigured in place via
 * `Compartment`s so toggling them does not lose undo history, and the
 * document is only ever replaced wholesale when `resetSignal.token`
 * changes (initial load, discard, or reload-after-conflict).
 */
export function CodeMirrorEditor({
  resetSignal,
  languageKey,
  wordWrap,
  onChange,
  onCursorChange,
  className,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const wrapCompartmentRef = useRef(new Compartment());
  const appliedTokenRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);

  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;

  // Create the view once (and re-create it whenever `resetSignal.token`
  // changes: that is the signal that the document itself, not just an
  // option, must be replaced). `resetSignal.token` is the only intended
  // trigger: `wordWrap` and `languageKey`'s initial values are only read
  // here (as a snapshot for the fresh state), and their later changes are
  // applied in place by the two effects below instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const languageCompartment = languageCompartmentRef.current;
    const wrapCompartment = wrapCompartmentRef.current;

    const state = EditorState.create({
      doc: resetSignal.text,
      extensions: [
        ...baseExtensions(),
        languageCompartment.of([]),
        wrapCompartment.of(wordWrap ? [EditorView.lineWrapping] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            onCursorChangeRef.current(update.state.selection.main.head);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    appliedTokenRef.current = resetSignal.token;
    onCursorChangeRef.current(view.state.selection.main.head);

    void loadLanguageExtension(languageKey).then((extension) => {
      view.dispatch({ effects: languageCompartment.reconfigure(extension) });
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [resetSignal.token]);

  // Reconfigure the language in place when it changes without a reset.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    let cancelled = false;
    void loadLanguageExtension(languageKey).then((extension) => {
      if (!cancelled) {
        view.dispatch({ effects: languageCompartmentRef.current.reconfigure(extension) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [languageKey]);

  // Reconfigure word wrap in place.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    view.dispatch({
      effects: wrapCompartmentRef.current.reconfigure(wordWrap ? [EditorView.lineWrapping] : []),
    });
  }, [wordWrap]);

  return <div ref={containerRef} className={className} />;
}
