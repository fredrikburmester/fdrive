// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableGroupRow,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageBar,
  PageBody,
  PageEmpty,
  PageSection,
  SettingActions,
  SettingRow,
} from "./page-layout";

afterEach(cleanup);

function slot(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector(`[data-slot="${name}"]`);
  if (found === null) throw new Error(`no ${name}`);
  return found as HTMLElement;
}

describe("PageBody", () => {
  it("is a plain container, never a second main landmark", () => {
    const { container } = render(
      <PageBody className="md:flex-row" aria-label="Trash">
        <p>rows</p>
      </PageBody>,
    );

    const body = slot(container, "page-body");
    expect(body.tagName).toBe("DIV");
    expect(screen.queryByRole("main")).toBeNull();
    expect(body.getAttribute("aria-label")).toBe("Trash");
    expect(body.classList.contains("md:flex-row")).toBe(true);
    expect(within(body).getByText("rows")).toBeDefined();
  });
});

describe("PageBar", () => {
  it("shows the summary and the actions", () => {
    const { container } = render(
      <PageBar actions={<button type="button">Empty Trash</button>}>
        <span>3 items</span>
      </PageBar>,
    );

    const bar = slot(container, "page-bar");
    expect(within(bar).getByText("3 items")).toBeDefined();
    expect(within(bar).getByRole("button", { name: "Empty Trash" })).toBeDefined();
  });

  it("leaves the actions group out when there are none", () => {
    const { container } = render(<PageBar actions={null}>12 photos</PageBar>);

    const bar = slot(container, "page-bar");
    expect(bar.children).toHaveLength(1);
    expect(within(bar).getByText("12 photos")).toBeDefined();
  });
});

describe("PageSection", () => {
  it("titles its content with a heading, a description and actions", () => {
    const { container } = render(
      <PageSection
        title="API tokens"
        description="Long-lived tokens."
        actions={<button type="button">New token</button>}
        padded
        aria-label="tokens"
      >
        <p>none yet</p>
      </PageSection>,
    );

    const section = slot(container, "page-section");
    expect(section.getAttribute("aria-label")).toBe("tokens");
    expect(within(section).getByRole("heading", { level: 2, name: "API tokens" })).toBeDefined();
    expect(within(section).getByText("Long-lived tokens.")).toBeDefined();
    expect(within(section).getByRole("button", { name: "New token" })).toBeDefined();
    const content = slot(container, "page-section-content");
    expect(within(content).getByText("none yet")).toBeDefined();
    expect(content.classList.contains("p-3")).toBe(true);
  });

  it("is only a header row without content, description or actions", () => {
    const { container } = render(<PageSection title="Usage" />);

    const section = slot(container, "page-section");
    expect(within(section).getByRole("heading", { name: "Usage" })).toBeDefined();
    expect(section.querySelector("p")).toBeNull();
    expect(section.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-slot="page-section-content"]')).toBeNull();
  });

  it("leaves row content unpadded by default", () => {
    const { container } = render(
      <PageSection title="Formats">
        <SettingRow label="Sizes">Binary</SettingRow>
      </PageSection>,
    );

    expect(slot(container, "page-section-content").classList.contains("p-3")).toBe(false);
  });
});

describe("SettingRow", () => {
  it("labels the control it names, with a one-line description", () => {
    const { container } = render(
      <SettingRow label="Name" description="Shown to others." htmlFor="name" className="py-4">
        <input id="name" />
      </SettingRow>,
    );

    expect(screen.getByLabelText("Name").id).toBe("name");
    expect(screen.getByText("Shown to others.")).toBeDefined();
    const row = slot(container, "setting-row");
    expect(row.classList.contains("py-4")).toBe(true);
    // Two columns by the room its section has, not by the window's width.
    expect(row.className).toContain("@2xl:grid-cols-");
    expect(row.className).not.toContain("md:grid-cols-");
  });

  it("shows a read-only value beside a plain label", () => {
    const { container } = render(<SettingRow label="Version">0.7.1</SettingRow>);

    const row = slot(container, "setting-row");
    expect(row.querySelector("label")).toBeNull();
    expect(within(row).getByText("Version").tagName).toBe("P");
    expect(within(row).getByText("0.7.1")).toBeDefined();
    expect(row.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("SettingActions", () => {
  it("holds a form's buttons in the row that ends it", () => {
    const { container } = render(
      <SettingActions className="border-t">
        <button type="submit">Save</button>
      </SettingActions>,
    );

    const actions = slot(container, "setting-actions");
    expect(within(actions).getByRole("button", { name: "Save" })).toBeDefined();
    expect(actions.classList.contains("border-t")).toBe(true);
  });
});

describe("PageEmpty", () => {
  it("says what is missing, with an icon, a description and an action", () => {
    const { container } = render(
      <PageEmpty
        icon={Trash2}
        title="Trash is empty"
        description="Deleted files show up here."
        action={<button type="button">Open Files</button>}
      />,
    );

    const empty = slot(container, "page-empty");
    expect(within(empty).getByText("Trash is empty")).toBeDefined();
    expect(within(empty).getByText("Deleted files show up here.")).toBeDefined();
    expect(within(empty).getByRole("button", { name: "Open Files" })).toBeDefined();
    expect(empty.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is just a title when nothing else is given", () => {
    const { container } = render(<PageEmpty title="No shares" />);

    const empty = slot(container, "page-empty");
    expect(empty.querySelector("svg")).toBeNull();
    expect(empty.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("DataTable", () => {
  it("is a real table with column headers, group rows and cells", () => {
    render(
      <DataTable className="table-fixed" aria-label="Activity">
        <DataTableHeader className="sticky">
          <DataTableRow>
            <DataTableHead className="w-24">Time</DataTableHead>
            <DataTableHead>Item</DataTableHead>
          </DataTableRow>
        </DataTableHeader>
        <DataTableBody>
          <DataTableGroupRow colSpan={2} className="day">
            Today
          </DataTableGroupRow>
          <DataTableRow className="cursor-pointer" data-state="selected">
            <DataTableCell className="tabular-nums">10:55</DataTableCell>
            <DataTableCell>budget.csv</DataTableCell>
          </DataTableRow>
        </DataTableBody>
      </DataTable>,
    );

    const table = screen.getByRole("table", { name: "Activity" });
    expect(table.classList.contains("table-fixed")).toBe(true);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Time", "Item", "Today"]);
    expect(screen.getByRole("columnheader", { name: "Time" }).classList.contains("w-24")).toBe(
      true,
    );

    const group = screen.getByRole("columnheader", { name: "Today" });
    expect(group.getAttribute("colspan")).toBe("2");
    expect(group.getAttribute("scope")).toBe("colgroup");
    expect(group.closest("tr")?.classList.contains("day")).toBe(true);

    const row = screen.getByRole("cell", { name: "budget.csv" }).closest("tr");
    expect(row?.classList.contains("cursor-pointer")).toBe(true);
    expect(row?.getAttribute("data-state")).toBe("selected");
    expect(screen.getByRole("cell", { name: "10:55" }).classList.contains("tabular-nums")).toBe(
      true,
    );
  });
});
