// @vitest-environment jsdom
import {
  type AdminProviderType,
  ApiClientError,
  type SetupStatusResponse,
} from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";

const WEBDAV: AdminProviderType = {
  type: "webdav",
  label: "WebDAV",
  configFields: [],
  credentialFields: [
    { name: "username", label: "Username", kind: "text", required: true },
    { name: "password", label: "Password", kind: "password", required: true },
  ],
  capabilities: { ...allCapabilities(false), trash: true, zip: true },
};
const S3: AdminProviderType = {
  type: "s3",
  label: "S3",
  configFields: [{ name: "region", label: "Region", kind: "text", required: true }],
  credentialFields: [
    { name: "accessKeyId", label: "Access key ID", kind: "text", required: true },
    { name: "secretAccessKey", label: "Secret access key", kind: "password", required: true },
  ],
  capabilities: { ...allCapabilities(false), trash: true },
};

type Mutation = {
  mutate: ReturnType<typeof vi.fn>;
  reset?: ReturnType<typeof vi.fn>;
  data?: { ok: boolean; detail: string };
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
  test: { mutate: vi.fn(), reset: vi.fn() } as Mutation,
  complete: { mutate: vi.fn() } as Mutation,
}));
vi.mock("@/lib/api/system-queries", () => ({
  useSetupStatus: () => mocks.status,
  useSetupTest: () => mocks.test,
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
  mocks.test = { mutate: vi.fn(), reset: vi.fn() };
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

describe("with a local folder", () => {
  const LOCAL: SetupStatusResponse = { required: true, mode: "local", types: [] };

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
        request: { kind: "local", username: "ada", password: "analytical-engine" },
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

describe("without a local folder", () => {
  const PROVIDER: SetupStatusResponse = { required: true, mode: "provider", types: [WEBDAV, S3] };

  it("connects WebDAV, tests it, signs in and continues to features", () => {
    mocks.test.mutate.mockImplementation((_input, options) => options.onSuccess());
    mocks.test.data = { ok: true, detail: "Reachable" };
    mocks.complete.mutate.mockImplementation((_input, options) => options.onSuccess());
    renderWizard(PROVIDER);

    expect(screen.getByText("Step 1 of 13")).toBeTruthy();
    claim();
    expect(screen.getByText("Connect the storage people sign in to")).toBeTruthy();
    expect(screen.getByText(/Files only\./)).toBeTruthy();
    type("Storage name", "  Home storage  ");
    type("Address", " https://dav.example.com/ ");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(mocks.test.mutate).toHaveBeenCalledWith(
      {
        token: "claim-token",
        request: { type: "webdav", baseUrl: "https://dav.example.com/", config: {} },
      },
      expect.anything(),
    );
    expect(screen.getByText("Reachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Sign in to your storage")).toBeTruthy();
    expect(screen.getByText(/Sign in with your account on Home storage/)).toBeTruthy();
    type("Username", "ada");
    type("Password", "secret");
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));

    expect(mocks.complete.mutate).toHaveBeenCalledWith(
      {
        token: "claim-token",
        request: {
          kind: "provider",
          type: "webdav",
          baseUrl: "https://dav.example.com/",
          label: "Home storage",
          credential: { username: "ada", password: "secret" },
        },
      },
      expect.anything(),
    );
    expect(screen.getByText("Optional feature choices")).toBeTruthy();
  });

  it("asks the chosen type for its own configuration and sign-in fields", async () => {
    mocks.test.mutate.mockImplementation((_input, options) => options.onSuccess());
    mocks.test.data = { ok: true, detail: "Reachable" };
    renderWizard(PROVIDER);
    claim();

    fireEvent.click(screen.getByRole("combobox", { name: "Storage type" }));
    fireEvent.keyDown(await screen.findByRole("option", { name: "S3" }), { key: "Enter" });
    expect(mocks.test.reset).toHaveBeenCalled();
    type("Storage name", "Media");
    type("Address", "https://s3.example.com/media");
    const test = screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(screen.getByText("Enter region.")).toBeTruthy();
    type("Region", "eu-west-1");
    fireEvent.click(test);
    expect(mocks.test.mutate).toHaveBeenCalledWith(
      {
        token: "claim-token",
        request: {
          type: "s3",
          baseUrl: "https://s3.example.com/media",
          config: { region: "eu-west-1" },
        },
      },
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Access key ID")).toBeTruthy();
    expect(screen.getByLabelText("Secret access key")).toBeTruthy();
  });

  it("requires a valid name without invalidating a successful connection test", () => {
    mocks.test.mutate.mockImplementation((_input, options) => options.onSuccess());
    mocks.test.data = { ok: true, detail: "Reachable" };
    renderWizard(PROVIDER);
    claim();
    type("Address", "https://dav.example.com/");
    type("Storage name", "Home storage");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);

    type("Storage name", "   ");
    expect(screen.getByText("Enter a name for this storage.")).toBeTruthy();
    expect(next.disabled).toBe(true);
    type("Storage name", "x".repeat(121));
    expect(screen.getByText("Use 120 characters or fewer for the storage name.")).toBeTruthy();
    expect(next.disabled).toBe(true);
    type("Storage name", "Renamed");
    expect(next.disabled).toBe(false);
    expect(mocks.test.mutate).toHaveBeenCalledTimes(1);
  });

  it("drops a passing test once the address changes", () => {
    mocks.test.mutate.mockImplementation((_input, options) => options.onSuccess());
    mocks.test.data = { ok: true, detail: "Reachable" };
    renderWizard(PROVIDER);
    claim();
    type("Storage name", "Home storage");
    type("Address", "https://dav.example.com/");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    type("Address", "https://other.example.com/");

    expect(screen.queryByText("Reachable")).toBeNull();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows why a probe failed", () => {
    mocks.test.mutate.mockImplementation((_input, options) => options.onSuccess());
    mocks.test.data = { ok: false, detail: "connect ECONNREFUSED" };
    renderWizard(PROVIDER);
    claim();
    type("Storage name", "Home storage");
    type("Address", "https://dav.example.com/");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(screen.getByText("connect ECONNREFUSED")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("explains a refused sign-in", () => {
    mocks.test.mutate.mockImplementation((_input, options) => options.onSuccess());
    mocks.test.data = { ok: true, detail: "Reachable" };
    mocks.complete.isError = true;
    mocks.complete.error = new ApiClientError("unauthorized", "invalid credentials", 401);
    renderWizard(PROVIDER);
    claim();
    type("Storage name", "Home storage");
    type("Address", "https://dav.example.com/");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByText("Sign-in failed. Check the setup token and your sign-in details."),
    ).toBeTruthy();
  });
});
