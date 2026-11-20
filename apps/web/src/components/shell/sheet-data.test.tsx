// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BarList, Code, FactList } from "./sheet-data";

afterEach(cleanup);

/** The filled part of a row's bar. */
function fillOf(row: HTMLElement): HTMLElement {
  const fill = row.querySelector('[data-slot="bar-fill"]');
  if (fill === null) throw new Error("no bar");
  return fill as HTMLElement;
}

/** How much of its track a row's bar fills, in percent. */
function widthOf(row: HTMLElement): number {
  const width = fillOf(row).style.width;
  expect(width.endsWith("%")).toBe(true);
  return Number.parseFloat(width);
}

describe("BarList", () => {
  it("gives every count a row with its name, its number and its share of the sum", () => {
    render(
      <BarList
        items={[
          { label: "Indexed", value: 1500 },
          { label: "Waiting", value: 500 },
        ]}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Indexed1,500", "Waiting500"]);
    expect(rows.map(widthOf)).toEqual([75, 25]);
    // The number is in the row, so the bar itself says nothing to assistive technology.
    for (const row of rows) {
      expect(fillOf(row).parentElement?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("measures against a given whole, and never past it", () => {
    render(
      <BarList
        total={200}
        items={[
          { label: "Done", value: 50 },
          { label: "Over", value: 300 },
          { label: "None", value: 0 },
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem").map(widthOf)).toEqual([25, 100, 0]);
  });

  it("draws empty bars when there is nothing to share", () => {
    render(
      <BarList
        items={[
          { label: "Indexed", value: 0 },
          { label: "Waiting", value: 0 },
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem").map(widthOf)).toEqual([0, 0]);
  });

  it("ends a row with the caller's text in place of the count", () => {
    render(<BarList items={[{ label: "Photos", value: 2048, display: "2 GB" }]} />);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("2 GB")).toBeDefined();
    expect(within(row).queryByText("2,048")).toBeNull();
  });

  it("fills a healthy bar green and writes a failed count in red", () => {
    render(
      <BarList
        items={[
          { label: "Plain", value: 4 },
          { label: "Healthy", value: 3, tone: "success" },
          { label: "Failed", value: 2, tone: "danger" },
          { label: "No failures", value: 0, tone: "danger" },
        ]}
      />,
    );

    const [plain, healthy, failed, clean] = screen.getAllByRole("listitem") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(plain.getAttribute("data-tone")).toBe("neutral");
    expect(fillOf(plain).classList.contains("bg-muted-foreground")).toBe(true);
    expect(plain.classList.contains("text-destructive")).toBe(false);

    expect(healthy.getAttribute("data-tone")).toBe("success");
    expect(fillOf(healthy).classList.contains("bg-success-dot")).toBe(true);
    expect(healthy.classList.contains("text-destructive")).toBe(false);

    expect(failed.getAttribute("data-tone")).toBe("danger");
    expect(fillOf(failed).classList.contains("bg-destructive")).toBe(true);
    expect(failed.classList.contains("text-destructive")).toBe(true);

    // Nothing failed, so nothing is red.
    expect(clean.getAttribute("data-tone")).toBe("danger");
    expect(clean.classList.contains("text-destructive")).toBe(false);
  });

  it("is a list that takes a class and its own attributes", () => {
    render(<BarList items={[]} className="mt-2" aria-label="Search index" />);

    const list = screen.getByRole("list", { name: "Search index" });
    expect(list.getAttribute("data-slot")).toBe("bar-list");
    expect(list.classList.contains("mt-2")).toBe(true);
    expect(list.children).toHaveLength(0);
  });
});

describe("FactList", () => {
  it("pairs every name with its value, in order", () => {
    const { container } = render(
      <FactList
        facts={[
          { label: "Version", value: "0.8.0" },
          { label: "Files folder", value: <code>/data/files</code> },
        ]}
      />,
    );

    const list = container.querySelector('[data-slot="fact-list"]') as HTMLElement;
    expect(list.tagName).toBe("DL");
    expect(Array.from(list.querySelectorAll("dt"), (term) => term.textContent)).toEqual([
      "Version",
      "Files folder",
    ]);
    expect(Array.from(list.querySelectorAll("dd"), (value) => value.textContent)).toEqual([
      "0.8.0",
      "/data/files",
    ]);
    // Each value follows its own name.
    for (const term of list.querySelectorAll("dt")) {
      expect(term.nextElementSibling?.tagName).toBe("DD");
    }
    expect(within(list).getByText("/data/files").tagName).toBe("CODE");
  });

  it("takes a class and its own attributes", () => {
    const { container } = render(<FactList facts={[]} className="mt-2" aria-label="About" />);

    const list = container.querySelector('[data-slot="fact-list"]') as HTMLElement;
    expect(list.classList.contains("mt-2")).toBe(true);
    expect(list.getAttribute("aria-label")).toBe("About");
    expect(list.children).toHaveLength(0);
  });
});

describe("Code", () => {
  it("sets a value a person copies in the mono face", () => {
    render(
      <Code className="break-all" title="Revision">
        0b06612a
      </Code>,
    );

    const code = screen.getByText("0b06612a");
    expect(code.tagName).toBe("CODE");
    expect(code.classList.contains("font-mono")).toBe(true);
    expect(code.classList.contains("break-all")).toBe(true);
    expect(code.getAttribute("title")).toBe("Revision");
  });
});
