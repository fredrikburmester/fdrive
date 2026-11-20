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

/** A row's cells as text. The name's cell also holds the summary line a narrow sheet shows. */
function cellsOf(row: HTMLElement) {
  return within(row)
    .getAllByRole("cell")
    .map((cell) => (cell.querySelector('[data-slot="token-name"]') ?? cell).textContent);
}

describe("ApiTokensSection", () => {
  it("shows a placeholder while the tokens load, and waits for the account to create one", () => {
    mocks.me = undefined;
    mocks.tokens = { data: undefined, isLoading: true };
    const { container } = render(<ApiTokensSection />);

    // The section is its own sheet, and its name is the page's heading.
    const sheet = screen.getByRole("region", { name: "API tokens" });
    expect(within(sheet).getByRole("heading", { level: 1, name: "API tokens" })).toBeDefined();
    expect(
      within(sheet).getByText("Long-lived tokens for Claude (MCP) and Raycast."),
    ).toBeDefined();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText("No tokens yet.")).toBeNull();
    const create = screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it("offers Create token as the sheet's one action, in its header", () => {
    mocks.tokens = { data: { items: [CLAUDE] }, isLoading: false };
    const { container } = render(<ApiTokensSection />);

    const actions = container.querySelector('[data-slot="detail-sheet-actions"]') as HTMLElement;
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Create token"]);
    // Every other button on the sheet revokes a token, in that token's own row.
    const sheet = screen.getByRole("region", { name: "API tokens" });
    const others = within(sheet)
      .getAllByRole("button")
      .filter((button) => !actions.contains(button));
    expect(others.map((button) => button.textContent)).toEqual(["Revoke"]);
    expect(others[0]?.closest("tr")).toBe(screen.getByRole("row", { name: /Claude/ }));
  });

  it("says when there are no tokens", () => {
    render(<ApiTokensSection />);

    expect(screen.getByText("No tokens yet.")).toBeDefined();
    expect(
      screen.getByText("Create one to connect Claude or Raycast to your files."),
    ).toBeDefined();
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
    expect(cellsOf(claude)).toEqual([
      "Claude",
      "Full management",
      "/docs, /notes",
      "2026-09-11",
      "Never",
      "2026-12-10",
      "Revoke",
    ]);
    const raycast = screen.getByRole("row", { name: /Raycast/ });
    expect(cellsOf(raycast)).toEqual([
      "Raycast",
      "Read",
      "/",
      "2026-10-01",
      "2026-11-19",
      "Never",
      "Revoke",
    ]);
    expect(screen.queryByText("No tokens yet.")).toBeNull();
  });

  it("folds access and expiry into a line under the name where the sheet is narrow", () => {
    mocks.tokens = { data: { items: [CLAUDE, RAYCAST] }, isLoading: false };
    const { container } = render(<ApiTokensSection />);

    const summaries = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="token-summary"]'),
    );
    expect(summaries.map((summary) => summary.textContent)).toEqual([
      "Full management · Expires 2026-12-10",
      "Read · Never expires",
    ]);
    // The line goes at the width where the columns it stands in for arrive.
    for (const summary of summaries) {
      expect(summary.classList.contains("@xl:hidden")).toBe(true);
    }
    const hiddenBelow = (name: string) =>
      Array.from(screen.getByRole("columnheader", { name }).classList).filter((token) =>
        token.startsWith("@max-"),
      );
    expect(hiddenBelow("Name")).toEqual([]);
    expect(hiddenBelow("Actions")).toEqual([]);
    expect(hiddenBelow("Access")).toEqual(["@max-xl:hidden"]);
    expect(hiddenBelow("Folders")).toEqual(["@max-xl:hidden"]);
    expect(hiddenBelow("Expires")).toEqual(["@max-xl:hidden"]);
    expect(hiddenBelow("Last used")).toEqual(["@max-3xl:hidden"]);
    expect(hiddenBelow("Created")).toEqual(["@max-5xl:hidden"]);
    // A cell hides with its column, or the row would not line up under the headers.
    const row = screen.getByRole("row", { name: /Raycast/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => Array.from(cell.classList).filter((token) => token.startsWith("@max-"))),
    ).toEqual([
      [],
      ["@max-xl:hidden"],
      ["@max-xl:hidden"],
      ["@max-5xl:hidden"],
      ["@max-3xl:hidden"],
      ["@max-xl:hidden"],
      [],
    ]);
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
