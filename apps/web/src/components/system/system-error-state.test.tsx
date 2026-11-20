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

  it("says what failed in the destructive colour, with no card or box around it", () => {
    const { container } = render(<SystemErrorState error={new Error("boom")} onRetry={vi.fn()} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't load this page");
    expect(alert.textContent).toContain("boom");
    expect(alert.className).toContain("text-destructive");
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(container.querySelector('[data-slot="alert"]')).toBeNull();
    const state = container.querySelector('[data-slot="system-error"]') as HTMLElement;
    expect(state.className).not.toContain("border");
  });

  it("stands as a row among setting rows when asked to, and names the setting that failed", () => {
    const { container } = render(
      <SystemErrorState
        row
        title="Couldn't load the server address"
        error={new Error("boom")}
        onRetry={vi.fn()}
      />,
    );

    const state = container.querySelector('[data-slot="system-error"]') as HTMLElement;
    expect(state.className).toContain("border-t");
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load the server address");
    expect(screen.queryByText("Couldn't load this page")).toBeNull();
  });

  it("stays flat inside the setup walkthrough's cards, and still retries", () => {
    const onRetry = vi.fn();
    const { container } = render(
      <SystemCardSurface>
        <SystemErrorState error={new Error("boom")} onRetry={onRetry} />
      </SystemCardSurface>,
    );

    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(container.querySelector('[data-slot="system-error"]')).not.toBeNull();
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
