// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Route } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AreaList,
  type AreaListItem,
  DetailSheet,
  ListSheet,
  ListSheetTrail,
  SheetColumns,
  SheetDock,
} from "./list-sheet";

afterEach(cleanup);

function slot(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector(`[data-slot="${name}"]`);
  if (found === null) throw new Error(`no ${name}`);
  return found as HTMLElement;
}

/** Hidden below the `md` breakpoint, where a phone shows the list or the sheet, not both. */
const PHONE_HIDDEN = "max-md:hidden";
/** Hidden from the `md` breakpoint up, where the list and the sheet show side by side. */
const WIDE_HIDDEN = "md:hidden";

const AREAS: readonly AreaListItem[] = [
  { id: "general", label: "General", href: "/system/general" as Route },
  {
    id: "users",
    label: "Users",
    href: "/system/users" as Route,
    description: "People who can sign in",
  },
  {
    id: "backups",
    label: "Backups",
    href: "/system/backups" as Route,
    description: "Destinations and schedule",
  },
];

describe("ListSheet", () => {
  function mount(index: boolean) {
    const { container } = render(
      <ListSheet index={index} list={<nav aria-label="Areas">rows</nav>} className="h-full">
        <p>The sheet</p>
      </ListSheet>,
    );
    return {
      frame: slot(container, "list-sheet"),
      list: slot(container, "list-sheet-list"),
      content: slot(container, "list-sheet-content"),
    };
  }

  it("holds the list and the chosen area's sheet", () => {
    const { frame, list, content } = mount(true);

    expect(frame.classList.contains("h-full")).toBe(true);
    expect(within(list).getByRole("navigation", { name: "Areas" })).toBeDefined();
    expect(within(content).getByText("The sheet")).toBeDefined();
    // The list comes first, so it is on the left and read first.
    expect(frame.firstElementChild).toBe(list);
    expect(frame.lastElementChild).toBe(content);
  });

  it("shows a phone the list alone on the frame's own URL", () => {
    const { list, content } = mount(true);

    expect(list.classList.contains(PHONE_HIDDEN)).toBe(false);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(true);
  });

  it("shows a phone the sheet alone on an area's URL", () => {
    const { list, content } = mount(false);

    expect(list.classList.contains(PHONE_HIDDEN)).toBe(true);
    expect(content.classList.contains(PHONE_HIDDEN)).toBe(false);
  });
});

describe("AreaList", () => {
  it("links every area to its own URL, in order, under the list's name", () => {
    render(<AreaList title="System" label="System areas" items={AREAS} currentId="general" />);

    const nav = screen.getByRole("navigation", { name: "System areas" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["General", "/system/general"],
      ["UsersPeople who can sign in", "/system/users"],
      ["BackupsDestinations and schedule", "/system/backups"],
    ]);
    expect(within(nav).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows the frame's name over the rows on a wide screen only, and not as a heading", () => {
    render(<AreaList title="System" label="System areas" items={AREAS} currentId="general" />);

    const title = screen.getByText("System");
    expect(title.classList.contains(PHONE_HIDDEN)).toBe(true);
    // The sheet's title is the page's heading, and on a phone the page header's is.
    expect(title.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("marks only the chosen area as the current page", () => {
    render(<AreaList title="System" label="System areas" items={AREAS} currentId="users" />);

    const current = screen.getByRole("link", { name: "Users" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.hasAttribute("data-active")).toBe(true);
    for (const name of ["General", "Backups"]) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("aria-current")).toBeNull();
      expect(link.hasAttribute("data-active")).toBe(false);
    }
  });

  it("marks no area for an id it does not list", () => {
    render(<AreaList title="System" label="System areas" items={AREAS} currentId="nope" />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("aria-current")).toBeNull();
    }
  });

  it("names a row by its label alone and describes it with its one line, for a phone", () => {
    render(<AreaList title="System" label="System areas" items={AREAS} currentId="general" />);

    const users = screen.getByRole("link", { name: "Users" });
    const description = document.getElementById(users.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("People who can sign in");
    expect(description?.classList.contains(WIDE_HIDDEN)).toBe(true);
    // A phone row ends in a chevron, which says nothing to assistive technology.
    const chevron = users.querySelector("svg");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    expect(chevron?.classList.contains(WIDE_HIDDEN)).toBe(true);
  });

  it("leaves a row without a description undescribed", () => {
    render(<AreaList title="System" label="System areas" items={AREAS} currentId="general" />);

    const general = screen.getByRole("link", { name: "General" });
    expect(general.hasAttribute("aria-describedby")).toBe(false);
    expect(general.textContent).toBe("General");
  });

  it("ends each row with what the caller gives for it", () => {
    render(
      <AreaList
        title="System"
        label="System areas"
        items={AREAS}
        currentId="general"
        renderEnd={(item) => (item.id === "users" ? <span data-testid="count">4</span> : undefined)}
      />,
    );

    // What ends the row is not part of its name.
    const users = screen.getByRole("link", { name: "Users" });
    expect(within(users).getByTestId("count").textContent).toBe("4");
    expect(screen.getAllByTestId("count")).toHaveLength(1);
  });

  it("shows a quiet line under the rows when given one, and takes a class", () => {
    const { rerender } = render(
      <AreaList
        title="System"
        label="System areas"
        items={AREAS}
        currentId="general"
        footer="Admins only."
        className="w-64"
      />,
    );

    const nav = screen.getByRole("navigation", { name: "System areas" });
    expect(nav.classList.contains("w-64")).toBe(true);
    expect(within(nav).getByText("Admins only.")).toBeDefined();
    expect(nav.lastElementChild?.textContent).toBe("Admins only.");

    rerender(<AreaList title="System" label="System areas" items={AREAS} currentId="general" />);
    expect(screen.queryByText("Admins only.")).toBeNull();
    expect(screen.getByRole("navigation").lastElementChild?.tagName).toBe("UL");

    rerender(
      <AreaList
        title="System"
        label="System areas"
        items={AREAS}
        currentId="general"
        footer={null}
      />,
    );
    expect(screen.getByRole("navigation").lastElementChild?.tagName).toBe("UL");
  });
});

describe("ListSheetTrail", () => {
  it("is the page's heading on a phone at the frame's own URL, with nothing to go back to", () => {
    const { container } = render(
      <ListSheetTrail title="Settings" href={"/account" as Route} index />,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Settings" });
    expect(heading.classList.contains(WIDE_HIDDEN)).toBe(true);
    expect(screen.queryByRole("link")).toBeNull();
    // A wide screen reads the frame's name as plain text: the sheet's title is its heading.
    const wide = within(slot(container, "list-sheet-trail"))
      .getAllByText("Settings")
      .find((element) => element !== heading);
    expect(wide?.tagName).toBe("SPAN");
    expect(wide?.classList.contains(PHONE_HIDDEN)).toBe(true);
  });

  it("leads back to the list from an area on a phone", () => {
    const { container } = render(
      <ListSheetTrail title="Settings" href={"/account" as Route} index={false} />,
    );

    const back = screen.getByRole("link", { name: "Back to Settings" });
    expect(back.getAttribute("href")).toBe("/account");
    expect(back.classList.contains(WIDE_HIDDEN)).toBe(true);
    expect(back.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // The area's sheet brings the heading.
    expect(screen.queryByRole("heading")).toBeNull();
    const wide = within(slot(container, "list-sheet-trail"))
      .getAllByText("Settings")
      .find((element) => element !== back);
    expect(wide?.classList.contains(PHONE_HIDDEN)).toBe(true);
  });
});

describe("DetailSheet", () => {
  it("is a region named by its title, which is the page's heading", () => {
    render(
      <DetailSheet title="Backups">
        <p>Schedule</p>
      </DetailSheet>,
    );

    const sheet = screen.getByRole("region", { name: "Backups" });
    expect(sheet.getAttribute("data-slot")).toBe("detail-sheet");
    expect(within(sheet).getByRole("heading", { level: 1, name: "Backups" })).toBeDefined();
    expect(within(sheet).getByText("Schedule")).toBeDefined();
  });

  it("titles a docked sheet with a second-level heading beside a page that has its own", () => {
    render(
      <DetailSheet title="report.pdf" titleAs="h2" width="docked">
        <p>Shared with two people</p>
      </DetailSheet>,
    );

    const sheet = screen.getByRole("region", { name: "report.pdf" });
    expect(within(sheet).getByRole("heading", { level: 2, name: "report.pdf" })).toBeDefined();
    expect(within(sheet).queryByRole("heading", { level: 1 })).toBeNull();
    expect(sheet.getAttribute("data-width")).toBe("docked");
  });

  it("fills the room beside the list unless it is docked", () => {
    const { container } = render(<DetailSheet title="General" />);

    expect(slot(container, "detail-sheet").getAttribute("data-width")).toBe("wide");
  });

  it("carries the lede, the status badges and the actions in its header", () => {
    const { container } = render(
      <DetailSheet
        title="Backups"
        lede="Copies of every file, off this server."
        badges={<span>Healthy</span>}
        actions={
          <>
            <button type="button">Restore</button>
            <button type="button">Back up now</button>
          </>
        }
      >
        <p>Schedule</p>
      </DetailSheet>,
    );

    const header = slot(container, "detail-sheet-header");
    expect(within(header).getByRole("heading", { name: "Backups" })).toBeDefined();
    expect(within(header).getByText("Copies of every file, off this server.")).toBeDefined();
    expect(within(slot(container, "detail-sheet-badges")).getByText("Healthy")).toBeDefined();
    const actions = slot(container, "detail-sheet-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Restore", "Back up now"]);
    // The content follows the header, outside it.
    expect(within(header).queryByText("Schedule")).toBeNull();
  });

  it("is only a title when nothing else is given", () => {
    const { container } = render(<DetailSheet title="About" lede={null} badges={null} />);

    const header = slot(container, "detail-sheet-header");
    expect(header.querySelector("p")).toBeNull();
    for (const name of ["detail-sheet-badges", "detail-sheet-actions", "detail-sheet-footer"]) {
      expect(container.querySelector(`[data-slot="${name}"]`)).toBeNull();
    }
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("has a close button of its own, apart from its actions, when it can be closed", () => {
    const onClose = vi.fn();
    const { container } = render(
      <DetailSheet
        title="report.pdf"
        width="docked"
        actions={<button type="button">Copy link</button>}
        onClose={onClose}
      />,
    );

    const actions = slot(container, "detail-sheet-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Copy link"]);
    const close = screen.getByRole("button", { name: "Close" });
    // Ahead of the header in the sheet, so it is the first thing focus reaches.
    expect(slot(container, "detail-sheet").firstElementChild).toBe(close);
    expect(close.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the close button alone when it has no other action", () => {
    const { container } = render(<DetailSheet title="report.pdf" onClose={vi.fn()} />);

    expect(container.querySelector('[data-slot="detail-sheet-actions"]')).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });

  it("ends in a footer for the note and the destructive action, after the content", () => {
    const { container } = render(
      <DetailSheet
        title="Search"
        footer={
          <>
            <p>Clearing removes the search index only.</p>
            <button type="button">Clear index</button>
          </>
        }
      >
        <p>Indexed files</p>
      </DetailSheet>,
    );

    const footer = slot(container, "detail-sheet-footer");
    expect(footer.tagName).toBe("FOOTER");
    expect(within(footer).getByText("Clearing removes the search index only.")).toBeDefined();
    expect(within(footer).getByRole("button", { name: "Clear index" })).toBeDefined();
    const sheet = slot(container, "detail-sheet");
    expect(sheet.lastElementChild).toBe(footer);
    expect(footer.previousElementSibling?.textContent).toBe("Indexed files");
  });

  it("takes a class and the section's own attributes", () => {
    const { container } = render(
      <DetailSheet title="Users" className="min-h-full" aria-busy="true" id="users-sheet" />,
    );

    const sheet = slot(container, "detail-sheet");
    expect(sheet.tagName).toBe("SECTION");
    expect(sheet.classList.contains("min-h-full")).toBe(true);
    expect(sheet.getAttribute("aria-busy")).toBe("true");
    expect(sheet.id).toBe("users-sheet");
  });

  it("names two sheets on one page apart", () => {
    render(
      <>
        <DetailSheet title="General" />
        <DetailSheet title="About" titleAs="h2" width="docked" />
      </>,
    );

    expect(screen.getByRole("region", { name: "General" })).not.toBe(
      screen.getByRole("region", { name: "About" }),
    );
  });
});

describe("SheetColumns", () => {
  it("holds two related blocks, with a class and attributes of its own", () => {
    const { container } = render(
      <SheetColumns className="items-start" aria-label="Index">
        <p>Bars</p>
        <p>Facts</p>
      </SheetColumns>,
    );

    const columns = slot(container, "sheet-columns");
    expect(columns.classList.contains("grid")).toBe(true);
    expect(columns.classList.contains("items-start")).toBe(true);
    expect(columns.getAttribute("aria-label")).toBe("Index");
    expect(Array.from(columns.children, (child) => child.textContent)).toEqual(["Bars", "Facts"]);
  });
});

describe("SheetDock", () => {
  it("keeps the page's rows and docks the chosen row's sheet after them", () => {
    const { container } = render(
      <SheetDock
        className="h-full"
        sheet={
          <DetailSheet title="report.pdf" titleAs="h2" width="docked">
            <p>Details</p>
          </DetailSheet>
        }
      >
        <p>Rows</p>
      </SheetDock>,
    );

    const dock = slot(container, "sheet-dock");
    expect(dock.classList.contains("h-full")).toBe(true);
    const rows = slot(container, "sheet-dock-rows");
    expect(within(rows).getByText("Rows")).toBeDefined();
    expect(within(rows).queryByText("Details")).toBeNull();
    expect(dock.firstElementChild).toBe(rows);
    expect(dock.lastElementChild).toBe(screen.getByRole("region", { name: "report.pdf" }));
  });

  it("is the rows alone while no row is chosen", () => {
    const { container } = render(
      <SheetDock>
        <p>Rows</p>
      </SheetDock>,
    );

    const dock = slot(container, "sheet-dock");
    expect(dock.children).toHaveLength(1);
    expect(screen.queryByRole("region")).toBeNull();
  });
});
