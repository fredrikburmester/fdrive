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
});
