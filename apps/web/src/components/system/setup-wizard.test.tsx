// @vitest-environment jsdom
import { ApiClientError, type SetupStatusResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Mutation = {
  mutate: ReturnType<typeof vi.fn>;
  isPending?: boolean;
  isError?: boolean;
  error?: unknown;
};

const mocks = vi.hoisted(() => ({
  status: {
    data: undefined as SetupStatusResponse | undefined,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  complete: { mutate: vi.fn() } as Mutation,
}));
vi.mock("@/lib/api/system-queries", () => ({
  useSetupStatus: () => mocks.status,
  useSetupComplete: () => mocks.complete,
}));
vi.mock("./features-page", () => ({ SetupFeatures: () => <main>Optional feature choices</main> }));

import { SetupWizard } from "./setup-wizard";

function renderWizard(status: SetupStatusResponse) {
  mocks.status.data = status;
  return render(<SetupWizard />);
}

function claim() {
  fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "claim-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.status = { data: undefined, isError: false, error: null, refetch: vi.fn() };
  mocks.complete = { mutate: vi.fn() };
});

describe("before the setup status answers", () => {
  it("waits for the status", () => {
    render(<SetupWizard />);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });

  it("says why it cannot start and retries", () => {
    mocks.status.isError = true;
    mocks.status.error = new ApiClientError("upstream_unavailable", "down", 502);
    render(<SetupWizard />);

    expect(screen.getByText(/fdrive can't reach the server/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.status.refetch).toHaveBeenCalled();
  });
});

describe("without the files folder", () => {
  it("asks for FDRIVE_STORAGE_ROOT instead of the form, and checks again", () => {
    renderWizard({ required: true, storageConfigured: false });

    expect(screen.getByText("Choose where fdrive keeps files")).toBeTruthy();
    expect(screen.getByText("FDRIVE_STORAGE_ROOT")).toBeTruthy();
    expect(screen.getByText(/restart fdrive, then check again\./)).toBeTruthy();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
    expect(screen.queryByText(/^Step /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.status.refetch).toHaveBeenCalled();
  });
});

describe("with the files folder", () => {
  const LOCAL: SetupStatusResponse = { required: true, storageConfigured: true };

  it("claims with the token, creates the owner's account and continues to features", () => {
    mocks.complete.mutate.mockImplementation((_input, options) => options.onSuccess());
    renderWizard(LOCAL);

    expect(screen.getByText("Step 1 of 12")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Storage" })).toBeNull();
    claim();
    expect(screen.getByText("Create your account")).toBeTruthy();
    expect(screen.getByText("Step 2 of 12")).toBeTruthy();

    type("Username", "  ada  ");
    type("Password", "analytical-engine");
    type("Confirm password", "analytical-engine");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(mocks.complete.mutate).toHaveBeenCalledWith(
      {
        token: "claim-token",
        request: { username: "ada", password: "analytical-engine" },
      },
      expect.anything(),
    );
    expect(screen.getByText("Optional feature choices")).toBeTruthy();
  });

  it("keeps the account button off until the name, password and repeat are valid", () => {
    renderWizard(LOCAL);
    claim();
    const create = screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();

    type("Username", "../root");
    expect(screen.getByText(/starting with a letter or digit/)).toBeTruthy();
    type("Username", "ada");
    type("Password", "short");
    expect(screen.getByText("Use at least 8 characters.")).toBeTruthy();
    type("Password", "long enough");
    type("Confirm password", "long enuogh");
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect(create.disabled).toBe(true);

    type("Confirm password", "long enough");
    expect(create.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Setup token")).toBeTruthy();
  });

  it("shows the account being created", () => {
    mocks.complete.isPending = true;
    renderWizard(LOCAL);
    claim();

    expect((screen.getByRole("button", { name: "Creating…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("explains any other refusal", () => {
    mocks.complete.isError = true;
    mocks.complete.error = new ApiClientError("conflict", "setup already done", 409);
    renderWizard(LOCAL);
    claim();

    expect(
      screen.queryByText("The setup token was not accepted. Go back and check it."),
    ).toBeNull();
    expect(
      screen.getByText("That change conflicts with the current state. Refresh and try again."),
    ).toBeTruthy();
  });

  it("points at the token when the API refuses it", () => {
    mocks.complete.isError = true;
    mocks.complete.error = new ApiClientError(
      "unauthorized",
      "invalid or missing setup token",
      401,
    );
    renderWizard(LOCAL);
    claim();

    expect(
      screen.getByText("The setup token was not accepted. Go back and check it."),
    ).toBeTruthy();
  });
});
