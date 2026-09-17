// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveActivity, LiveActivityDock } from "./live-activity-dock";

describe("LiveActivityDock", () => {
  afterEach(cleanup);

  it("gathers activities mounted anywhere under it into the one bottom-right corner", () => {
    const { container } = render(
      <LiveActivityDock>
        <main>
          <LiveActivity>
            <button type="button">Uploading 2 files</button>
          </LiveActivity>
          <section>
            <LiveActivity>
              <button type="button" className="order-last">
                Uploaded 1
              </button>
            </LiveActivity>
            <LiveActivity>
              <button type="button">Suggestions ready</button>
            </LiveActivity>
          </section>
        </main>
      </LiveActivityDock>,
    );

    const dock = container.querySelector('[data-slot="live-activity-dock"]');
    expect(dock).not.toBeNull();
    expect(dock?.className).toContain("fixed");
    expect(dock?.className).toContain("pointer-events-none");
    expect(container.querySelector("main")?.querySelector("button")).toBeNull();
    const labels = Array.from(dock?.querySelectorAll("button") ?? []).map((b) => b.textContent);
    expect(labels).toEqual(["Uploading 2 files", "Uploaded 1", "Suggestions ready"]);
  });

  it("renders an activity in place when there is no dock", () => {
    render(
      <LiveActivity>
        <button type="button">Uploading 2 files</button>
      </LiveActivity>,
    );
    expect(screen.getByRole("button", { name: "Uploading 2 files" })).toBeTruthy();
  });
});
