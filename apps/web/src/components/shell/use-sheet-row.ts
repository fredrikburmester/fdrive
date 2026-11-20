"use client";

import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";

/**
 * A control inside a row keeps its own click: a checkbox, a button, a link or a select never
 * chooses the row. A cell that should not choose it either carries `data-row-control`.
 */
const OWN_CLICK =
  "a, button, input, label, select, textarea, [role='checkbox'], [role='combobox'], [data-row-control]";

/**
 * The look of a row that opens a sheet, beside `rowProps`: the keyboard's focus is a ring drawn
 * inside the row, on the hover ground.
 */
export const SHEET_ROW =
  "focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** On the name inside such a row: medium weight while the row's sheet is open. */
export const CHOSEN_NAME = "in-aria-selected:font-medium";

/** Spread on a row (a `DataTableRow`, or a tile) so that choosing it opens its sheet. */
export interface SheetRowProps {
  ref: (node: HTMLElement | null) => void;
  tabIndex: 0;
  "aria-selected": boolean;
  "data-state": "selected" | undefined;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Spread on the row's `DetailSheet`, with `width="docked"`, inside the page's `SheetDock`. */
export interface RowSheetProps {
  ref: (node: HTMLElement | null) => void;
  tabIndex: -1;
  onClose: () => void;
}

export interface SheetRow<T> {
  /** The row whose sheet is open, or `null`. A chosen row that leaves `rows` closes its sheet. */
  chosen: T | null;
  rowProps: (id: string) => SheetRowProps;
  sheetProps: RowSheetProps;
  /** Closes the sheet and returns focus to its row. */
  close: () => void;
}

/**
 * The chosen row of a `SheetDock` page: a click on a row, or Enter or Space on it, opens its
 * sheet and moves focus there. Escape and the sheet's close button close it and return focus to
 * the row.
 */
export function useSheetRow<T extends { readonly id: string }>(rows: readonly T[]): SheetRow<T> {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const rowNodes = useRef(new Map<string, HTMLElement>());
  const sheetNode = useRef<HTMLElement | null>(null);
  const chosen = rows.find((row) => row.id === chosenId) ?? null;
  const openId = chosen?.id ?? null;

  // The sheet is a screen of its own on a phone and a column far from the row on a wide screen:
  // focus follows the choice, so the keyboard and a screen reader land in what just opened.
  useEffect(() => {
    if (openId !== null) sheetNode.current?.focus({ preventScroll: true });
  }, [openId]);

  // Escape closes the sheet from anywhere in the rows or the sheet, and when nothing has focus,
  // as after a button that was just used turned itself off. A menu or a dialog is drawn outside
  // both and closes itself, and the rest of the page keeps the key.
  useEffect(() => {
    if (openId === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const sheet = sheetNode.current;
      const dock = sheet?.closest("[data-slot='sheet-dock']") ?? sheet?.parentElement;
      const target = event.target;
      const inside = target instanceof Node && dock?.contains(target) === true;
      if (target !== document.body && !inside) return;
      const row = rowNodes.current.get(openId);
      setChosenId(null);
      row?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openId]);

  function choose(id: string) {
    setChosenId(id);
    if (id === openId) sheetNode.current?.focus({ preventScroll: true });
  }

  function close() {
    const row = openId === null ? undefined : rowNodes.current.get(openId);
    setChosenId(null);
    row?.focus();
  }

  return {
    chosen,
    close,
    rowProps: (id) => ({
      ref: (node) => {
        if (node === null) rowNodes.current.delete(id);
        else rowNodes.current.set(id, node);
      },
      tabIndex: 0,
      "aria-selected": id === openId,
      "data-state": id === openId ? "selected" : undefined,
      onClick: (event) => {
        if (event.target instanceof Element && event.target.closest(OWN_CLICK) !== null) return;
        choose(id);
      },
      onKeyDown: (event) => {
        // Keys pressed in a control inside the row belong to that control.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose(id);
        }
      },
    }),
    sheetProps: {
      ref: (node) => {
        sheetNode.current = node;
      },
      tabIndex: -1,
      onClose: close,
    },
  };
}
