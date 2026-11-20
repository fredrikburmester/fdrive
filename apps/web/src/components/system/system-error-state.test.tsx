// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemErrorState } from "./system-error-state";
import { SystemCardSurface } from "./system-section";

afterEach(() => {
  cleanup();
});

describe("SystemErrorState", () => {
  it("renders the message from describeApiError for the given error", () => {
    render(<SystemErrorState error={new Error("network dropped")} onRetry={vi.fn()} />);

    expect(screen.getByText("network dropped")).toBeTruthy();
  });

  it("falls back to the generic message for a non-Error value", () => {
    render(<SystemErrorState error="nope" onRetry={vi.fn()} />);

    expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy();
  });

  it("is one flat row on a page and a card in the setup walkthrough", () => {
    const page = render(<SystemErrorState error={new Error("boom")} onRetry={vi.fn()} />);
    expect(page.container.querySelector('[data-slot="system-error"]')).not.toBeNull();
    expect(page.container.querySelector('[data-slot="card"]')).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load this page");
    page.unmount();

    const onRetry = vi.fn();
    const card = render(
      <SystemCardSurface>
        <SystemErrorState error={new Error("boom")} onRetry={onRetry} />
      </SystemCardSurface>,
    );
    expect(card.container.querySelector('[data-slot="card"]')).not.toBeNull();
    expect(card.container.querySelector('[data-slot="system-error"]')).toBeNull();
    expect(screen.getByText("boom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry when the Retry button is clicked", () => {
    const onRetry = vi.fn();
    render(<SystemErrorState error={new Error("boom")} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
