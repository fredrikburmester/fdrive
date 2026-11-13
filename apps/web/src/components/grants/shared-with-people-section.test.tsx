// @vitest-environment jsdom
import { ApiClientError, type OwnedGrant } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const PHOTOS_GRACE: OwnedGrant = {
  id: "00000000-0000-4000-8000-0000000000a1",
  path: "/Photos",
  username: "grace",
  access: "read",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const PHOTOS_ADA: OwnedGrant = {
  ...PHOTOS_GRACE,
  id: "00000000-0000-4000-8000-0000000000a2",
  username: "ada",
  access: "write",
};
const DOCS: OwnedGrant = {
  ...PHOTOS_GRACE,
  id: "00000000-0000-4000-8000-0000000000a3",
  path: "/Work/Docs",
};

type Mutation = { mutate: ReturnType<typeof vi.fn>; isPending: boolean };
const mocks = vi.hoisted(() => ({
  grants: {} as {
    data?: { owned: OwnedGrant[] };
    isPending: boolean;
    isError: boolean;
    error: unknown;
  },
  update: { mutate: vi.fn(), isPending: false } as Mutation,
  remove: { mutate: vi.fn(), isPending: false } as Mutation,
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/grants/queries", () => ({
  useGrants: () => mocks.grants,
  useUpdateGrant: () => mocks.update,
  useDeleteGrant: () => mocks.remove,
}));

const { SharedWithPeopleSection } = await import("./shared-with-people-section");

function show(owned: OwnedGrant[]) {
  mocks.grants = { data: { owned }, isPending: false, isError: false, error: null };
  return render(<SharedWithPeopleSection />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists each shared folder and person, by folder then name, with a link to the folder", () => {
  show([DOCS, PHOTOS_GRACE, PHOTOS_ADA]);

  expect(screen.getByRole("heading", { name: "Shared with people" })).toBeTruthy();
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getAllByRole("cell")[1]?.textContent)).toEqual([
    "ada",
    "grace",
    "grace",
  ]);
  const docs = within(rows[2] as HTMLElement).getByRole("link", { name: "Docs" });
  expect(docs.getAttribute("href")).toBe("/files/Work/Docs");
  expect(within(rows[0] as HTMLElement).getByRole("combobox").textContent).toContain("Can edit");
});

it("changes access and stops sharing from the list", async () => {
  mocks.update.mutate.mockImplementation((_input, options) => options.onSuccess());
  mocks.remove.mutate.mockImplementation((_input, options) => options.onSuccess());
  show([PHOTOS_ADA]);

  fireEvent.click(screen.getByRole("combobox", { name: "Access for ada to Photos" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Can view" }), { key: "Enter" });
  expect(mocks.update.mutate).toHaveBeenCalledWith(
    { id: PHOTOS_ADA.id, access: "read" },
    expect.anything(),
  );
  expect(mocks.success).toHaveBeenCalledWith("ada can now only view Photos.");

  fireEvent.click(screen.getByRole("button", { name: "Stop sharing Photos with ada" }));
  expect(mocks.remove.mutate).toHaveBeenCalledWith(PHOTOS_ADA.id, expect.anything());
  expect(mocks.success).toHaveBeenCalledWith("Stopped sharing Photos with ada.");
});

it("keeps the same access without asking the server", async () => {
  show([PHOTOS_ADA]);

  fireEvent.click(screen.getByRole("combobox", { name: "Access for ada to Photos" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Can edit" }), { key: "Enter" });

  expect(mocks.update.mutate).not.toHaveBeenCalled();
});

it("says when nothing is shared, and shows loading and failures", () => {
  const view = show([]);
  expect(screen.getByText("You don't share any folders with people yet.")).toBeTruthy();

  mocks.grants = { isPending: true, isError: false, error: null };
  view.rerender(<SharedWithPeopleSection />);
  expect(screen.queryByRole("table")).toBeNull();

  mocks.grants = {
    isPending: false,
    isError: true,
    error: new ApiClientError("upstream_unavailable", "down", 502),
  };
  view.rerender(<SharedWithPeopleSection />);
  expect(screen.getByText(/fdrive can't reach the server/)).toBeTruthy();
});
