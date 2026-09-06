// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the breadcrumb and actions slots", () => {
    render(
      <PageHeader breadcrumb={<span>Home</span>} actions={<button type="button">New</button>} />,
    );
    expect(screen.getByText("Home").textContent).toBe("Home");
    expect(screen.getByRole("button", { name: "New" }).textContent).toBe("New");
  });

  it("renders with no slots given", () => {
    render(<PageHeader />);
    expect(document.querySelector("header")).not.toBeNull();
  });
});
