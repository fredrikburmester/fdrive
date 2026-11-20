// @vitest-environment jsdom
import type { AboutResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { AboutDialog } from "./about-dialog";

const ABOUT: AboutResponse = {
  version: "0.8.0",
  release: "0.8.0",
  uptimeSeconds: 120,
  setupRequired: false,
};

const about = vi.spyOn(apiClient, "about");
const onOpenChange = vi.fn();

function renderDialog(open: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dialog = (state: boolean) => (
    <QueryClientProvider client={client}>
      <AboutDialog open={state} onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  const view = render(dialog(open));
  return { setOpen: (state: boolean) => view.rerender(dialog(state)) };
}

beforeEach(() => {
  about.mockReset();
  onOpenChange.mockReset();
});
afterEach(cleanup);

it("asks the API nothing until it is opened", () => {
  about.mockResolvedValue(ABOUT);
  renderDialog(false);

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(about).not.toHaveBeenCalled();
});

it("opens as a sheet named About fdrive, and fills in the server once it answers", async () => {
  let answer: (value: AboutResponse) => void = () => {};
  about.mockReturnValue(
    new Promise<AboutResponse>((resolve) => {
      answer = resolve;
    }),
  );
  renderDialog(true);

  const dialog = await screen.findByRole("dialog", { name: "About fdrive" });
  // Everything that does not need the server is there at once.
  expect(within(dialog).getByRole("heading", { level: 2, name: "About fdrive" })).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "GitHub" })).toBeTruthy();
  expect(within(dialog).getByRole("status").textContent).toBe("Loading…");

  answer(ABOUT);
  expect((await within(dialog).findByText("Version")).nextElementSibling?.textContent).toBe(
    "0.8.0",
  );
  expect(within(dialog).getByText("API uptime").nextElementSibling?.textContent).toBe("2m");
  expect(within(dialog).queryByRole("status")).toBeNull();
  expect(about).toHaveBeenCalledOnce();
});

it("closes from its own close button", async () => {
  about.mockResolvedValue(ABOUT);
  renderDialog(true);

  const dialog = await screen.findByRole("dialog", { name: "About fdrive" });
  // One close button: the sheet's own, not a second one from the popup.
  const close = within(dialog).getAllByRole("button", { name: "Close" });
  expect(close).toHaveLength(1);
  fireEvent.click(close[0] as HTMLElement);

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("says why the server could not be read, and asks again on Retry", async () => {
  about.mockRejectedValueOnce(new Error("offline"));
  renderDialog(true);

  const dialog = await screen.findByRole("dialog", { name: "About fdrive" });
  expect((await within(dialog).findByRole("alert")).textContent).toBe("offline");
  // The links do not depend on the server.
  expect(within(dialog).getByRole("link", { name: "Search & AI" })).toBeTruthy();

  about.mockResolvedValue(ABOUT);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

  expect(await within(dialog).findByText("Version")).toBeTruthy();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(about).toHaveBeenCalledTimes(2);
});

it("reads the uptime again each time it opens", async () => {
  about.mockResolvedValueOnce(ABOUT);
  const view = renderDialog(true);
  expect(await screen.findByText("2m")).toBeTruthy();

  view.setOpen(false);
  about.mockResolvedValueOnce({ ...ABOUT, uptimeSeconds: 3 * 3600 });
  view.setOpen(true);

  expect(await screen.findByText("3h 0m")).toBeTruthy();
  expect(about).toHaveBeenCalledTimes(2);
});
