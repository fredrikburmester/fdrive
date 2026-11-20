// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SystemAlert,
  SystemCardSurface,
  SystemLine,
  SystemNote,
  SystemSection,
} from "./system-section";

afterEach(cleanup);

describe("SystemSection", () => {
  it("renders the title as a heading, with its description, actions, and body", () => {
    const { container } = render(
      <SystemSection
        title="Status"
        description="How the sidecar is doing."
        actions={<button type="button">Test</button>}
      >
        <p>Body</p>
      </SystemSection>,
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeTruthy();
    expect(screen.getByText("How the sidecar is doing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    // Rows bring their own hairlines, so the body sits straight in the section.
    const content = container.querySelector('[data-slot="page-section-content"]');
    expect(content?.firstElementChild).toBe(screen.getByText("Body"));
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  });

  it("omits the description and content areas when there is nothing to put in them", () => {
    const { container } = render(<SystemSection title="Editors" />);

    expect(screen.getByText("Editors")).toBeTruthy();
    expect(container.querySelector('[data-slot="page-section"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="page-section-content"]')).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("stacks content that is not rows 12px apart, or as far as the section asks", () => {
    render(
      <>
        <SystemSection title="Notes" padded>
          <p>Body</p>
        </SystemSection>
        <SystemSection title="Looser" padded contentClassName="gap-4">
          <p>Other body</p>
        </SystemSection>
      </>,
    );

    const wrapper = screen.getByText("Body").parentElement;
    expect(wrapper?.className).toContain("flex-col");
    expect(wrapper?.className).toContain("gap-3");
    // The sheet pads its blocks, so the stack brings no padding of its own.
    expect(wrapper?.className).not.toMatch(/(^|\s)p-\d/);
    expect(wrapper?.parentElement?.dataset.slot).toBe("page-section-content");
    const looser = screen.getByText("Other body").parentElement;
    expect(looser?.className).toContain("gap-4");
    expect(looser?.className).not.toContain("gap-3");
  });

  it("is a card inside the setup walkthrough", () => {
    const { container } = render(
      <SystemCardSurface>
        <SystemSection
          title="Server address"
          description="Where fdrive lives."
          actions={<button type="button">Test</button>}
          padded
        >
          <p>Body</p>
        </SystemSection>
        <SystemSection title="Bare" />
      </SystemCardSurface>,
    );

    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="page-section"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="card-description"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="card-action"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="card-content"]')).toHaveLength(1);
    expect(screen.getByText("Where fdrive lives.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
  });
});

describe("the text blocks of a System page", () => {
  it("keeps a note, a line and an alert apart by role and tone", () => {
    render(
      <>
        <SystemNote className="extra">
          <p>Why this matters.</p>
        </SystemNote>
        <SystemLine role="status">Loading…</SystemLine>
        <SystemAlert>Something failed.</SystemAlert>
        <SystemAlert row>The folder is missing.</SystemAlert>
      </>,
    );

    const note = screen.getByText("Why this matters.").parentElement;
    expect(note?.dataset.slot).toBe("system-note");
    expect(note?.className).toContain("extra");
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    const [inline, row] = screen.getAllByRole("alert");
    expect(inline?.textContent).toBe("Something failed.");
    expect(inline?.className).toContain("text-destructive");
    expect(inline?.className).not.toContain("border-t");
    // As a row of its own the alert takes the hairline and the padding of the rows around it.
    expect(row?.className).toContain("text-destructive");
    expect(row?.className).toContain("border-t");
    expect(row?.className).toContain("py-4.5");
  });
});
