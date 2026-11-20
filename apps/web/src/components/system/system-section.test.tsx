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
    // Rows bring their own padding, so the body sits edge to edge in a flat section.
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

  it("pads and stacks content that is not rows", () => {
    render(
      <SystemSection title="Notes" padded contentClassName="gap-4">
        <p>Body</p>
      </SystemSection>,
    );

    const wrapper = screen.getByText("Body").parentElement;
    expect(wrapper?.className).toContain("p-3");
    expect(wrapper?.className).toContain("gap-4");
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
    expect(inline?.className).not.toContain("px-3");
    // As a row of its own the alert is padded like the rows around it.
    expect(row?.className).toContain("px-3");
  });
});
