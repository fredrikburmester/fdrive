// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, expect, it } from "vitest";
import { useSheetRow } from "./use-sheet-row";

interface Item {
  readonly id: string;
  readonly name: string;
}

const ITEMS: Item[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

/**
 * A table of rows with a checkbox and a button each, and the chosen row's sheet beside it. The
 * sheet draws one field elsewhere in the page, as a menu or a dialog opened from it would be.
 */
function Rows({ items }: { items: readonly Item[] }) {
  const sheet = useSheetRow(items);
  const { onClose, ...sheetProps } = sheet.sheetProps;
  return (
    <>
      <table>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} {...sheet.rowProps(item.id)}>
              <td data-row-control data-testid={`control-${item.id}`}>
                <input type="checkbox" aria-label={`Select ${item.name}`} />
              </td>
              <td>{item.name}</td>
              <td>
                <button type="button">Copy {item.name}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.chosen !== null ? (
        <section aria-label={`${sheet.chosen.name} details`} {...sheetProps}>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <input aria-label="Name" />
          {createPortal(<input aria-label="Menu filter" />, document.body)}
        </section>
      ) : null}
    </>
  );
}

function row(name: string): HTMLElement {
  return screen.getByRole("row", { name: new RegExp(name) });
}

afterEach(cleanup);

it("opens a row's sheet on a click, marks the row and moves focus into the sheet", () => {
  render(<Rows items={ITEMS} />);
  expect(screen.queryByRole("region")).toBeNull();
  expect(row("Alpha").getAttribute("aria-selected")).toBe("false");
  expect(row("Alpha").getAttribute("data-state")).toBeNull();
  expect(row("Alpha").tabIndex).toBe(0);

  fireEvent.click(screen.getByText("Alpha"));

  const sheet = screen.getByRole("region", { name: "Alpha details" });
  expect(document.activeElement).toBe(sheet);
  expect(row("Alpha").getAttribute("aria-selected")).toBe("true");
  expect(row("Alpha").getAttribute("data-state")).toBe("selected");
  expect(row("Beta").getAttribute("aria-selected")).toBe("false");

  // Another row replaces the sheet, and focus follows.
  fireEvent.click(screen.getByText("Beta"));
  expect(screen.queryByRole("region", { name: "Alpha details" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Beta details" }));
  expect(row("Alpha").getAttribute("data-state")).toBeNull();
});

it("leaves a click on a control inside the row to that control", () => {
  render(<Rows items={ITEMS} />);

  fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy Alpha" }));
  // A near miss inside the checkbox's own cell.
  fireEvent.click(screen.getByTestId("control-a"));

  expect(screen.queryByRole("region")).toBeNull();
});

it("opens with Enter or Space on the row, and Escape closes and returns focus to it", () => {
  render(<Rows items={ITEMS} />);
  const alpha = row("Alpha");

  alpha.focus();
  fireEvent.keyDown(alpha, { key: "Enter" });
  const sheet = screen.getByRole("region", { name: "Alpha details" });
  expect(document.activeElement).toBe(sheet);

  // Escape from a field inside the sheet.
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
  expect(screen.queryByRole("region")).toBeNull();
  expect(document.activeElement).toBe(alpha);

  fireEvent.keyDown(alpha, { key: " " });
  expect(screen.getByRole("region", { name: "Alpha details" })).toBeTruthy();

  // Escape on another row closes the open sheet, and focus returns to that sheet's row.
  fireEvent.keyDown(row("Beta"), { key: "Escape" });
  expect(screen.queryByRole("region")).toBeNull();
  expect(document.activeElement).toBe(alpha);

  // So does Escape with nothing focused, as after a button turned itself off.
  fireEvent.keyDown(alpha, { key: "Enter" });
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("region")).toBeNull();
  expect(document.activeElement).toBe(alpha);
});

it("ignores keys pressed in a control inside the row, and other keys on the row", () => {
  render(<Rows items={ITEMS} />);

  fireEvent.keyDown(screen.getByRole("button", { name: "Copy Alpha" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("checkbox", { name: "Select Alpha" }), { key: " " });
  fireEvent.keyDown(row("Alpha"), { key: "ArrowDown" });
  fireEvent.keyDown(row("Alpha"), { key: "Escape" });

  expect(screen.queryByRole("region")).toBeNull();

  // Other keys leave an open sheet alone too.
  fireEvent.click(screen.getByText("Alpha"));
  fireEvent.keyDown(screen.getByRole("region", { name: "Alpha details" }), { key: "Enter" });
  expect(screen.getByRole("region", { name: "Alpha details" })).toBeTruthy();
});

it("keeps the sheet open when Escape belongs to something else", () => {
  render(<Rows items={ITEMS} />);
  fireEvent.click(screen.getByText("Alpha"));

  // A menu opened from the sheet is drawn outside the rows and the sheet, and closes itself.
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Menu filter" }), { key: "Escape" });
  expect(screen.getByRole("region", { name: "Alpha details" })).toBeTruthy();

  // A field that already acted on the key keeps it.
  const name = screen.getByRole("textbox", { name: "Name" });
  name.addEventListener("keydown", (event) => event.preventDefault());
  fireEvent.keyDown(name, { key: "Escape" });
  expect(screen.getByRole("region", { name: "Alpha details" })).toBeTruthy();
});

it("closes from the sheet's close button and returns focus to the row", () => {
  render(<Rows items={ITEMS} />);
  fireEvent.click(screen.getByText("Beta"));

  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  expect(screen.queryByRole("region")).toBeNull();
  expect(document.activeElement).toBe(row("Beta"));
});

it("moves focus back into the sheet when its row is chosen again", () => {
  render(<Rows items={ITEMS} />);
  fireEvent.click(screen.getByText("Alpha"));
  const alpha = row("Alpha");
  alpha.focus();

  fireEvent.keyDown(alpha, { key: "Enter" });

  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Alpha details" }));
});

it("closes the sheet when its row leaves the list", () => {
  const view = render(<Rows items={ITEMS} />);
  fireEvent.click(screen.getByText("Alpha"));
  expect(screen.getByRole("region", { name: "Alpha details" })).toBeTruthy();

  view.rerender(<Rows items={ITEMS.slice(1)} />);

  expect(screen.queryByRole("region")).toBeNull();
  expect(row("Beta").getAttribute("aria-selected")).toBe("false");
});
