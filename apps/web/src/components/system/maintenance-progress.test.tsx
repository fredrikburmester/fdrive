// @vitest-environment jsdom
import type { IndexerClearJob } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MaintenanceProgress } from "./maintenance-progress";

const idle: IndexerClearJob = {
  running: false,
  processed: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  errors: 0,
};
afterEach(cleanup);
describe("MaintenanceProgress", () => {
  it.each([undefined, idle])("hides jobs that have never run", (job) => {
    render(<MaintenanceProgress title="Index clear" job={job} />);
    expect(screen.queryByText("Index clear")).toBeNull();
  });
  it.each([true, false])("shows progress and errors when running is %s", (running) => {
    render(
      <MaintenanceProgress
        title="Index clear"
        job={{
          ...idle,
          running,
          startedAt: "2026-09-06T12:00:00Z",
          processed: 3,
          total: 4,
          errors: 1,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      `${running ? "Running" : "Completed with errors"} · 3 of 4 processed · 1 errors`,
    );
  });
  it("keeps the total unknown while discovering candidates", () => {
    render(
      <MaintenanceProgress title="Rebuild" job={{ ...idle, running: true, totalKnown: false }} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Discovering · 0 processed · 0 errors");
  });
  it("shows clean completion", () => {
    render(
      <MaintenanceProgress
        title="Index clear"
        job={{ ...idle, startedAt: "2026-09-06T12:00:00Z" }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Completed ·");
  });
  it("reports a failure even when admission failed before recording a start time", () => {
    render(<MaintenanceProgress title="Index clear" job={{ ...idle, errors: 1 }} />);
    expect(screen.getByRole("status").textContent).toContain("1 errors");
  });
  it("names the pass beside its progress, and links its errors to the failure history", () => {
    render(
      <MaintenanceProgress
        title="Index clear"
        job={{ ...idle, startedAt: "2026-09-06T12:00:00Z", processed: 4, total: 4, errors: 2 }}
      />,
    );
    expect(screen.getByText("Index clear")).toBeTruthy();
    expect(screen.getByRole("link", { name: "2 errors" }).getAttribute("href")).toBe(
      "#processing-failures",
    );
  });
  it("draws the share done as a bar only while a pass with a known total runs", () => {
    const running = { ...idle, running: true, startedAt: "2026-09-06T12:00:00Z" };
    const bar = () => document.querySelector<HTMLElement>('[data-slot="bar-fill"]');
    const view = render(
      <MaintenanceProgress title="Rebuild" job={{ ...running, processed: 3, total: 4 }} />,
    );
    expect(bar()?.style.width).toBe("75%");
    // More processed than first counted never overfills the bar.
    view.rerender(
      <MaintenanceProgress title="Rebuild" job={{ ...running, processed: 5, total: 4 }} />,
    );
    expect(bar()?.style.width).toBe("100%");
    // Still discovering: there is no whole to take a share of yet.
    view.rerender(
      <MaintenanceProgress
        title="Rebuild"
        job={{ ...running, processed: 3, total: 3, totalKnown: false }}
      />,
    );
    expect(bar()).toBeNull();
    view.rerender(<MaintenanceProgress title="Rebuild" job={{ ...running, total: 0 }} />);
    expect(bar()).toBeNull();
    // Finished: the line says so and the bar is gone.
    view.rerender(
      <MaintenanceProgress
        title="Rebuild"
        job={{ ...running, running: false, processed: 4, total: 4 }}
      />,
    );
    expect(bar()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Completed · 4 of 4 processed · 0 errors");
  });
  it("says when a pass was stopped", () => {
    render(
      <MaintenanceProgress
        title="Rebuild"
        job={{
          ...idle,
          startedAt: "2026-09-06T12:00:00Z",
          processed: 1,
          total: 4,
          outcome: "stopped",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Stopped · 1 of 4 processed · 0 errors");
  });
});
