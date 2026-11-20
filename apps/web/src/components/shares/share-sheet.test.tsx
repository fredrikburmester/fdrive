// @vitest-environment jsdom
import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatDate } from "@/lib/format";
import { ShareSheet } from "./share-sheet";

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  update: vi.fn(),
  gesture: vi.fn(),
}));
vi.mock("@/lib/shares/management", () => ({
  useShareManagement: () => ({
    query: {},
    create: vi.fn(),
    update: mocks.update,
    revoke: vi.fn(),
    entries: mocks.entries,
  }),
}));
vi.mock("@/lib/activity/gestures", () => ({
  activityGesture: (...args: unknown[]) => {
    mocks.gesture(...args);
    return () => Promise.resolve();
  },
}));

const share: ManagedShare = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Quarterly report",
  description: "",
  scope: "read",
  paths: ["/Reports/report.pdf"],
  publicPath: "/s/00000000-0000-4000-8000-000000000001",
  hasPassword: false,
  expiresAt: null,
  maxDownloads: 0,
  usedDownloads: 0,
  createdAt: "2026-01-01T12:00:00Z",
  updatedAt: "2026-01-01T12:00:00Z",
  presentation: "auto",
};

const file: FsEntry = {
  name: "report.pdf",
  path: "/Reports/report.pdf",
  kind: "file",
  size: 1,
  modifiedAt: "2026-01-01T00:00:00Z",
  ext: ".pdf",
  mime: "application/pdf",
};
const folder: FsEntry = {
  ...file,
  name: "Inbox",
  path: "/Inbox",
  kind: "dir",
  ext: "",
  mime: null,
};

const onRevoke = vi.fn();
const onClose = vi.fn();
let client: QueryClient;

function sheet(shown: ManagedShare) {
  return (
    <QueryClientProvider client={client}>
      <ShareSheet
        share={shown}
        onRevoke={onRevoke}
        ref={() => undefined}
        tabIndex={-1}
        onClose={onClose}
      />
    </QueryClientProvider>
  );
}

function show(shown: ManagedShare = share) {
  return render(sheet(shown));
}

/** The sheet's named values, by label. */
function facts(): Record<string, string> {
  const list = document.querySelector('[data-slot="fact-list"]');
  return Object.fromEntries(
    [...(list?.querySelectorAll("dt") ?? [])].map((term) => [
      term.textContent ?? "",
      term.nextElementSibling?.textContent ?? "",
    ]),
  );
}

function when(iso: string): string {
  return formatDate(new Date(iso), { style: "absolute", clock: "24h" });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.entries.mockResolvedValue([file]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it("shows a link's address, its state, what it shares and how it has been used", async () => {
  show();

  const region = screen.getByRole("region", { name: "Quarterly report" });
  expect(within(region).getByRole("heading", { level: 2, name: "Quarterly report" })).toBeTruthy();
  expect(screen.getByText("Anyone with the link can view and download.")).toBeTruthy();
  expect(screen.getByText("Active").getAttribute("data-tone")).toBe("success");
  expect(screen.queryByText("Password protected")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Share link" }) as HTMLInputElement).value).toBe(
    new URL(`/s/${share.id}`, window.location.origin).href,
  );

  expect(screen.getByRole("heading", { name: "Shared item" })).toBeTruthy();
  expect(screen.getByText("report.pdf")).toBeTruthy();
  expect(screen.getByText("/Reports/report.pdf").tagName).toBe("CODE");
  // A file opens in its folder, selected there.
  expect(screen.getByRole("link", { name: "Open report.pdf in Files" }).getAttribute("href")).toBe(
    "/files/Reports?select=report.pdf",
  );

  expect(facts()).toEqual({
    Created: when(share.createdAt),
    Expires: "Never",
    Usage: "0 downloads · No limit",
  });
  await screen.findByLabelText("Link name");
  expect(mocks.entries).toHaveBeenCalledWith(["/Reports/report.pdf"]);
});

it("says who can use a protected or an upload link, and when a link was changed", async () => {
  const view = show({
    ...share,
    hasPassword: true,
    updatedAt: "2026-02-02T12:00:00Z",
    expiresAt: "2030-06-15T12:00:00Z",
    maxDownloads: 5,
    usedDownloads: 2,
  });
  expect(
    screen.getByText("Anyone with the link and its password can view and download."),
  ).toBeTruthy();
  expect(screen.getByText("Password protected")).toBeTruthy();
  expect(facts()).toEqual({
    Created: when(share.createdAt),
    Changed: when("2026-02-02T12:00:00Z"),
    Expires: when("2030-06-15T12:00:00Z"),
    Usage: "2 of 5 downloads",
  });

  mocks.entries.mockResolvedValue([folder]);
  view.rerender(sheet({ ...share, scope: "write", paths: ["/Inbox"] }));
  expect(
    screen.getByText("Anyone with the link can upload files, without seeing what is there."),
  ).toBeTruthy();
  // A folder opens as itself once its kind is known.
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "Open Inbox in Files" }).getAttribute("href")).toBe(
      "/files/Inbox",
    ),
  );
});

it("says why a link no longer works", () => {
  const view = show({ ...share, expiresAt: "2020-01-01T00:00:00Z" });
  expect(screen.getByText("Expired").getAttribute("data-tone")).toBe("warning");
  expect(screen.getByText("This link stopped working when it expired.")).toBeTruthy();
  expect(screen.queryByText("Active")).toBeNull();

  view.rerender(sheet({ ...share, maxDownloads: 3, usedDownloads: 3 }));
  expect(screen.getByText("Limit reached").getAttribute("data-tone")).toBe("warning");
  expect(screen.getByText("This link stopped working when it reached its limit.")).toBeTruthy();
});

it("names the first shared items and counts the rest", () => {
  const paths = Array.from({ length: 22 }, (_, index) => `/photos/${index + 1}.jpg`);
  show({ ...share, paths });

  expect(screen.getByRole("heading", { name: "Shared items" })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(20);
  expect(screen.getByText("/photos/20.jpg")).toBeTruthy();
  expect(screen.queryByText("/photos/21.jpg")).toBeNull();
  expect(screen.getByText("And 2 more.")).toBeTruthy();
});

it("shares everything from the top folder, which opens as Files itself", () => {
  show({ ...share, paths: ["/"] });
  expect(screen.getByRole("link", { name: "Open Everything in Files" }).getAttribute("href")).toBe(
    "/files",
  );
});

it("copies the link and confirms it, or says that it could not", async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show();

  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect((await screen.findByText("Link copied")).getAttribute("role")).toBe("status");
  expect(writeText).toHaveBeenCalledWith(new URL(`/s/${share.id}`, window.location.origin).href);
  expect(mocks.gesture).toHaveBeenCalledWith("share.copy_link", "/Reports/report.pdf", share.id);

  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(
    await screen.findByText("Could not copy the link. Select and copy it above."),
  ).toBeTruthy();
  expect(screen.queryByText("Link copied")).toBeNull();
});

it("saves changed settings, and only once something changed", async () => {
  let saved: (value: ManagedShare) => void = () => {};
  mocks.update.mockImplementation(
    () =>
      new Promise<ManagedShare>((resolve) => {
        saved = resolve;
      }),
  );
  const view = show();
  expect(screen.getByRole("status").textContent).toBe("Loading settings…");

  const name = (await screen.findByLabelText("Link name")) as HTMLInputElement;
  expect(name.value).toBe("Quarterly report");
  expect(screen.getByRole("combobox", { name: "Access" }).textContent).toContain("Can view");
  expect(screen.getByRole("combobox", { name: "Show as" }).textContent).toContain("Automatic");
  expect(screen.getByRole("combobox", { name: "Password protection" }).textContent).toContain(
    "Keep without password",
  );
  expect(screen.queryByLabelText("New password")).toBeNull();
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toHaveProperty("disabled", true);

  fireEvent.change(name, { target: { value: "Renamed" } });
  expect(save).toHaveProperty("disabled", false);
  // Typing the old name back leaves nothing to save.
  fireEvent.change(name, { target: { value: "Quarterly report" } });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(name, { target: { value: "Renamed" } });
  fireEvent.change(screen.getByLabelText("Download limit"), { target: { value: "3" } });

  fireEvent.click(save);
  const saving = await screen.findByRole("button", { name: "Saving…" });
  expect(saving).toHaveProperty("disabled", true);
  expect(mocks.update).toHaveBeenCalledWith(
    share.id,
    expect.objectContaining({ name: "Renamed", maxDownloads: 3, paths: ["/Reports/report.pdf"] }),
  );
  expect(mocks.update.mock.calls[0]?.[1]).not.toHaveProperty("password");

  // The list refreshes before the save settles, so the sheet already has the changed link.
  const changed = { ...share, name: "Renamed", maxDownloads: 3 };
  view.rerender(sheet(changed));
  saved(changed);

  expect((await screen.findByText("Changes saved")).getAttribute("role")).toBe("status");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  expect((screen.getByLabelText("Link name") as HTMLInputElement).value).toBe("Renamed");
  expect(screen.getByRole("region", { name: "Renamed" })).toBeTruthy();

  // The confirmation lasts until the next change.
  fireEvent.change(screen.getByLabelText("Link name"), { target: { value: "Renamed again" } });
  expect(screen.queryByText("Changes saved")).toBeNull();
});

it("keeps a failed save's changes and says what went wrong", async () => {
  mocks.update.mockRejectedValue(new Error("Permission denied"));
  show();

  fireEvent.change(await screen.findByLabelText("Link name"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Permission denied")).toBeTruthy();
  expect((screen.getByLabelText("Link name") as HTMLInputElement).value).toBe("Renamed");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  expect(screen.queryByText("Changes saved")).toBeNull();
});

it("asks for the new password before saving a password change", async () => {
  show({ ...share, hasPassword: true });

  fireEvent.click(await screen.findByRole("combobox", { name: "Password protection" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Change password" }), {
    key: "Enter",
  });
  const password = screen.getByLabelText("New password") as HTMLInputElement;
  expect(password.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Enter the new password or choose Remove password.")).toBeTruthy();
  expect(mocks.update).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(password.type).toBe("text");
  expect(password.value).toHaveLength(20);
  mocks.update.mockResolvedValue({ ...share, hasPassword: true });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith(
      share.id,
      expect.objectContaining({ password: password.value }),
    ),
  );
  // A saved password leaves the form with the save.
  await screen.findByText("Changes saved");
  expect(screen.queryByLabelText("New password")).toBeNull();
}, 15000);

it("says when the shared files could not be loaded, and can still revoke the link", async () => {
  mocks.entries.mockRejectedValue(new Error("gone"));
  show();

  expect(
    await screen.findByText("Could not load the shared files. Refresh and try again."),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Link name")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
  expect(onRevoke).toHaveBeenCalledOnce();
});

it("says a link whose files are in Trash does not work, and points to Trash", () => {
  show({ ...share, paths: [`/.trash/${share.id}/report.pdf`] });

  expect(screen.getByText("In Trash", { selector: "[data-slot=status-badge]" })).toBeTruthy();
  expect(
    screen.getByText("This link does not work while what it shares is in Trash."),
  ).toBeTruthy();
  expect(screen.getByText("report.pdf")).toBeTruthy();
  // Where the item lies inside Trash is not shown.
  expect(screen.queryByText(/\.trash/)).toBeNull();
  expect(screen.getByRole("link", { name: "Find report.pdf in Trash" }).getAttribute("href")).toBe(
    "/trash",
  );
  expect(
    screen.getByText("Restore what this link shares from Trash to change its settings."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(mocks.entries).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Revoke link" })).toBeTruthy();
});

it("closes from its close button and keeps revoking apart in the footer", () => {
  show();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();

  const footer = document.querySelector('[data-slot="detail-sheet-footer"]') as HTMLElement;
  expect(footer.textContent).toContain("The original files remain in your storage.");
  fireEvent.click(within(footer).getByRole("button", { name: "Revoke link" }));
  expect(onRevoke).toHaveBeenCalledOnce();
});
