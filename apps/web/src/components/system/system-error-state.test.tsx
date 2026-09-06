// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemErrorState } from "./system-error-state";

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

  it("calls onRetry when the Retry button is clicked", () => {
    const onRetry = vi.fn();
    render(<SystemErrorState error={new Error("boom")} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
