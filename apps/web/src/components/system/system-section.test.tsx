// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SystemSection } from "./system-section";

afterEach(cleanup);

describe("SystemSection", () => {
  it("renders the title, description, actions, and body", () => {
    render(
      <SystemSection
        title="Status"
        description="How the sidecar is doing."
        actions={<button type="button">Test</button>}
      >
        <p>Body</p>
      </SystemSection>,
    );

    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("How the sidecar is doing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("omits the description and content areas when there is nothing to put in them", () => {
    const { container } = render(<SystemSection title="Editors" />);

    expect(screen.getByText("Editors")).toBeTruthy();
    expect(container.querySelector('[data-slot="card-description"]')).toBeNull();
    expect(container.querySelector('[data-slot="card-content"]')).toBeNull();
    expect(container.querySelector('[data-slot="card-action"]')).toBeNull();
  });
});
