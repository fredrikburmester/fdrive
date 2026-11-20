// @vitest-environment jsdom
import type {
  ApiTokenSummary,
  ApiTokensResponse,
  CreateApiTokenResponse,
  MeResponse,
} from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMe } from "@/test-fixtures/identity";

const mocks = vi.hoisted(() => ({
  me: undefined as MeResponse | undefined,
  tokens: { data: undefined as ApiTokensResponse | undefined, isLoading: false },
  revoke: vi.fn(),
  create: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
}));

vi.mock("@/components/shell/page-header", () => ({ useShellMe: () => ({ data: mocks.me }) }));
vi.mock("@/lib/account/queries", () => ({
  useApiTokens: () => mocks.tokens,
  useRevokeApiToken: () => ({ mutate: mocks.revoke }),
  useCreateApiToken: () => mocks.create,
}));

const { ApiTokensSection } = await import("./api-tokens-section");

const CLAUDE: ApiTokenSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Claude",
  createdAt: "2026-09-11T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2026-12-10T10:00:00.000Z",
  access: { mode: "full", paths: ["/docs", "/notes"] },
};

const RAYCAST: ApiTokenSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Raycast",
  createdAt: "2026-10-01T08:00:00.000Z",
  lastUsedAt: "2026-11-19T21:30:00.000Z",
  expiresAt: null,
  access: { mode: "read", paths: ["/"] },
};

beforeEach(() => {
  mocks.me = makeMe();
  mocks.tokens = { data: { items: [] }, isLoading: false };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApiTokensSection", () => {
  it("shows a placeholder while the tokens load, and waits for the account to create one", () => {
    mocks.me = undefined;
    mocks.tokens = { data: undefined, isLoading: true };
    const { container } = render(<ApiTokensSection />);

    expect(screen.getByRole("heading", { level: 2, name: "API tokens" })).toBeDefined();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText("No tokens yet.")).toBeNull();
    const create = screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it("says when there are no tokens", () => {
    render(<ApiTokensSection />);

    expect(screen.getByText("No tokens yet.")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    const create = screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
  });

  it("lists each token with its access, folders and dates, never a secret", () => {
    mocks.tokens = { data: { items: [CLAUDE, RAYCAST] }, isLoading: false };
    render(<ApiTokensSection />);

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Access",
      "Folders",
      "Created",
      "Last used",
      "Expires",
      "Actions",
    ]);
    const claude = screen.getByRole("row", { name: /Claude/ });
    expect(
      within(claude)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Claude",
      "Full management",
      "/docs, /notes",
      "2026-09-11",
      "Never",
      "2026-12-10",
      "Revoke",
    ]);
    const raycast = screen.getByRole("row", { name: /Raycast/ });
    expect(
      within(raycast)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Raycast", "Read", "/", "2026-10-01", "2026-11-19", "Never", "Revoke"]);
    expect(screen.queryByText("No tokens yet.")).toBeNull();
  });

  it("revokes a token only after it is confirmed", async () => {
    mocks.tokens = { data: { items: [CLAUDE] }, isLoading: false };
    render(<ApiTokensSection />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Revoke "Claude"?')).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.revoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(mocks.revoke).toHaveBeenCalledWith(CLAUDE.id);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("creates a token and shows its secret once", async () => {
    render(<ApiTokensSection />);

    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Raycast" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));

    expect(mocks.create.mutate).toHaveBeenCalledTimes(1);
    const [request, options] = mocks.create.mutate.mock.calls[0] as [
      { name: string },
      { onSuccess: (result: CreateApiTokenResponse) => void },
    ];
    expect(request).toMatchObject({ name: "Raycast", access: { mode: "read", paths: ["/"] } });
    act(() => options.onSuccess({ token: "fdr_secret", item: RAYCAST }));

    const created = await screen.findByRole("dialog", { name: "Token created" });
    expect(within(created).getByDisplayValue("fdr_secret")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Create API token" })).toBeNull();

    fireEvent.click(within(created).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Token created" })).toBeNull());
  });
});
