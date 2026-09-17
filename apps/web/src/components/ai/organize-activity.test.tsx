// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveActivityDock } from "@/components/activity/live-activity-dock";
import { OrganizeActivity } from "./organize-activity";

describe("OrganizeActivity", () => {
  afterEach(cleanup);

  it("shows nothing without a closed session", () => {
    const { container } = render(<OrganizeActivity status={null} onOpen={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows a run in progress as a pill in the dock", () => {
    const { container } = render(
      <LiveActivityDock>
        <OrganizeActivity status={{ state: "running", count: 1 }} onOpen={() => {}} />
      </LiveActivityDock>,
    );
    const dock = container.querySelector('[data-slot="live-activity-dock"]');
    const pill = dock?.querySelector("button");
    expect(pill?.textContent).toBe("Organizing 1 item…");
    expect(pill?.className).toContain("rounded-full");
  });

  it("reopens the sheet from waiting suggestions", () => {
    const onOpen = vi.fn();
    render(<OrganizeActivity status={{ state: "ready", count: 3 }} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Suggestions ready" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
