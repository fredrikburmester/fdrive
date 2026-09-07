// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NewOfficeDocumentDialog } from "./new-document-dialog";

afterEach(cleanup);
it("creates a validated document and allows cancellation", () => {
  const create = vi.fn();
  const close = vi.fn();
  render(
    <NewOfficeDocumentDialog
      kind="document"
      pending={false}
      error={null}
      onClose={close}
      onCreate={create}
    />,
  );
  expect(screen.getByLabelText<HTMLInputElement>("File name").value).toBe("Untitled.docx");
  fireEvent.change(screen.getByLabelText("File name"), { target: { value: "../bad.docx" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create" }).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("slashes");
  fireEvent.change(screen.getByLabelText("File name"), { target: { value: "report.docx" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(create).toHaveBeenCalledWith("report.docx");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});
it("switches format, displays collision errors, and prevents duplicate pending submission", async () => {
  const create = vi.fn();
  const props = {
    kind: "spreadsheet" as const,
    pending: false,
    error: "A file with this name already exists.",
    onClose: vi.fn(),
    onCreate: create,
  };
  const { rerender } = render(<NewOfficeDocumentDialog {...props} />);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.keyDown(await screen.findByRole("option", { name: "OpenDocument" }), { key: "Enter" });
  expect(screen.getByLabelText<HTMLInputElement>("File name").value).toBe("Untitled.ods");
  expect(screen.getByRole("alert").textContent).toContain("already exists");
  rerender(<NewOfficeDocumentDialog {...props} pending />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Creating…" }).disabled).toBe(true);
  fireEvent.submit(screen.getByLabelText("File name").closest("form") as HTMLFormElement);
  expect(create).not.toHaveBeenCalled();
});
