// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), test: vi.fn() }));
vi.mock("@/lib/api/system-queries", () => ({
  useSetupTest: () => ({ mutate: mocks.test, data: { ok: true, detail: "Reachable" } }),
  useSetupComplete: () => ({ mutate: mocks.complete }),
}));
vi.mock("./features-page", () => ({ SetupFeatures: () => <main>Optional feature choices</main> }));

import { SetupWizard } from "./setup-wizard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("continues from a file-user account straight into feature selection without navigation", () => {
  mocks.test.mockImplementation((_input, options) => options.onSuccess());
  mocks.complete.mockImplementation((_input, options) => options.onSuccess());
  render(<SetupWizard />);
  fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "claim-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("SFTPGo URL"), {
    target: { value: "http://sftpgo:8080" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText(/not a SFTPGo WebAdmin account/)).toBeTruthy();
  expect(screen.getByText(/Its SFTPGo permissions stay unchanged/)).toBeTruthy();
  expect(screen.queryByText("Home template")).toBeNull();
  fireEvent.change(screen.getByLabelText("SFTPGo file-user username"), {
    target: { value: "alice" },
  });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "alice-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  expect(mocks.complete).toHaveBeenCalledWith(
    expect.objectContaining({
      request: {
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "sftpgo:/{username}",
        username: "alice",
        password: "alice-password",
      },
    }),
    expect.anything(),
  );
  expect(screen.getByText("Optional feature choices")).toBeTruthy();
});
