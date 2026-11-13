// @vitest-environment jsdom
import { ApiClientError, type OwnedGrant } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const GRACE: OwnedGrant = {
  id: "00000000-0000-4000-8000-0000000000a1",
  path: "/Photos",
  username: "grace",
  access: "read",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const ELSEWHERE: OwnedGrant = {
  ...GRACE,
  id: "00000000-0000-4000-8000-0000000000a2",
  path: "/Docs",
  username: "linus",
};

type Mutation = { mutate: ReturnType<typeof vi.fn>; isPending: boolean };
const mutation = (): Mutation => ({ mutate: vi.fn(), isPending: false });

const mocks = vi.hoisted(() => ({
  grants: {} as {
    data?: { owned: OwnedGrant[] };
    isPending: boolean;
    isError: boolean;
    error: unknown;
  },
  people: {} as { data?: { usernames: string[] }; isError: boolean; error: unknown },
  create: undefined as unknown as Mutation,
  update: undefined as unknown as Mutation,
  remove: undefined as unknown as Mutation,
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/grants/queries", () => ({
  useGrants: () => mocks.grants,
  useGrantPeople: () => mocks.people,
  useCreateGrant: () => mocks.create,
  useUpdateGrant: () => mocks.update,
  useDeleteGrant: () => mocks.remove,
}));

const { ShareWithPeopleDialog } = await import("./share-with-people-dialog");

const onClose = vi.fn();

function reset() {
  mocks.grants = {
    data: { owned: [GRACE, ELSEWHERE] },
    isPending: false,
    isError: false,
    error: null,
  };
  mocks.people = { data: { usernames: ["ada", "grace", "linus"] }, isError: false, error: null };
  mocks.create = mutation();
  mocks.update = mutation();
  mocks.remove = mutation();
}
reset();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  reset();
});

function renderDialog() {
  return render(
    <ShareWithPeopleDialog folder={{ path: "/Photos", name: "Photos" }} onClose={onClose} />,
  );
}

/** Runs the mutation's `onSuccess`, or `onError` with `error`, when it is called. */
function settle(target: Mutation, error?: unknown) {
  target.mutate.mockImplementation(
    (_input: unknown, options: { onSuccess?: () => void; onError?: (cause: unknown) => void }) =>
      error === undefined ? options.onSuccess?.() : options.onError?.(error),
  );
}

async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter" });
}

describe("ShareWithPeopleDialog", () => {
  it("lists only the people who have this folder, with their access", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "Share Photos" })).toBeTruthy();
    const people = screen.getByRole("list", { name: "People with access" });
    expect(within(people).getByText("grace")).toBeTruthy();
    expect(within(people).queryByText("linus")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Access for grace" }).textContent).toContain(
      "Can view",
    );
  });

  it("changes someone's access and says so", async () => {
    settle(mocks.update);
    renderDialog();

    await choose("Access for grace", "Can edit");

    expect(mocks.update.mutate).toHaveBeenCalledWith(
      { id: GRACE.id, access: "write" },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith("grace can now edit Photos.");
  });

  it("stops sharing with someone", () => {
    settle(mocks.remove);
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with grace" }));

    expect(mocks.remove.mutate).toHaveBeenCalledWith(GRACE.id, expect.anything());
    expect(mocks.success).toHaveBeenCalledWith("Stopped sharing Photos with grace.");
  });

  it("shares with someone who does not have it yet, at the chosen access", async () => {
    settle(mocks.create);
    renderDialog();
    const share = screen.getByRole("button", { name: "Share" }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);

    fireEvent.click(screen.getByRole("combobox", { name: "Person" }));
    expect(await screen.findByRole("option", { name: "ada" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "grace" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("option", { name: "linus" }), { key: "Enter" });
    await choose("Access for the new person", "Can edit");
    expect(screen.getByText(/they can add, change and delete/)).toBeTruthy();
    fireEvent.click(share);

    expect(mocks.create.mutate).toHaveBeenCalledWith(
      { path: "/Photos", username: "linus", access: "write" },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith("Shared Photos with linus.");
  });

  it("reports a refused change in the API's words", async () => {
    settle(mocks.create, new ApiClientError("not_found", "no such user", 404));
    settle(mocks.update, new ApiClientError("not_found", "share not found", 404));
    settle(mocks.remove, new ApiClientError("forbidden", "nope", 403));
    renderDialog();

    await choose("Person", "ada");
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(mocks.error).toHaveBeenCalledWith("No such user.");
    await choose("Access for grace", "Can edit");
    expect(mocks.error).toHaveBeenCalledWith("Share not found.");
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with grace" }));
    expect(mocks.error).toHaveBeenCalledWith("You don't have permission to do that.");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("says when there is no one to add", () => {
    mocks.people = { data: { usernames: [] }, isError: false, error: null };
    mocks.grants = { data: { owned: [] }, isPending: false, isError: false, error: null };
    const view = renderDialog();
    expect(screen.getByText("Not shared with anyone yet.")).toBeTruthy();
    expect(screen.getByText("No one else has an account on this storage yet.")).toBeTruthy();

    mocks.people = { data: { usernames: ["grace"] }, isError: false, error: null };
    mocks.grants = { data: { owned: [GRACE] }, isPending: false, isError: false, error: null };
    view.rerender(
      <ShareWithPeopleDialog folder={{ path: "/Photos", name: "Photos" }} onClose={onClose} />,
    );
    expect(screen.getByText("Everyone with an account here already has this folder.")).toBeTruthy();
  });

  it("explains what each access level allows", () => {
    renderDialog();

    expect(screen.getByText("Can view: they can open and download, not change.")).toBeTruthy();
  });

  it("shows loading and failures", () => {
    mocks.grants = { isPending: true, isError: false, error: null };
    const view = renderDialog();
    expect(screen.queryByRole("list", { name: "People with access" })).toBeNull();

    mocks.grants = {
      isPending: false,
      isError: true,
      error: new ApiClientError("upstream_unavailable", "down", 502),
    };
    mocks.people = {
      isError: true,
      error: new ApiClientError("upstream_unavailable", "down", 502),
    };
    view.rerender(
      <ShareWithPeopleDialog folder={{ path: "/Photos", name: "Photos" }} onClose={onClose} />,
    );
    expect(screen.getAllByText(/fdrive can't reach the server/)).toHaveLength(2);
  });

  it("closes with Done", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalled();
  });
});
