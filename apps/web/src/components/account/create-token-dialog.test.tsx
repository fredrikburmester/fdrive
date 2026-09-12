// @vitest-environment jsdom
import type { CreateApiTokenResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { CreateTokenDialog } from "./create-token-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RESULT: CreateApiTokenResponse = {
  token: "fdrive_secret",
  item: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Claude",
    identityId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-09-11T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-12-10T10:00:00.000Z",
  },
};

function renderDialog(onCreated = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateTokenDialog
        identities={[
          {
            id: "22222222-2222-4222-8222-222222222222",
            username: "alice",
            providerType: "sftpgo",
            providerLabel: "Work",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            username: "alice",
            providerType: "webdav",
            providerLabel: "Personal",
          },
        ]}
        activeIdentityId={"22222222-2222-4222-8222-222222222222"}
        open
        onOpenChange={vi.fn()}
        onCreated={onCreated}
      />
    </QueryClientProvider>,
  );
  const input = screen.getByLabelText("Name") as HTMLInputElement;
  return { input, onCreated };
}

/**
 * Emulates a browser's implicit form submission, which jsdom does not
 * implement: Enter in a text field activates the form's default button, and
 * does nothing at all when the field is not in a form or the button is
 * disabled.
 */
function pressEnter(input: HTMLInputElement): void {
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  const form = input.form;
  if (form === null) return;
  const defaultButton = form.querySelector<HTMLButtonElement | HTMLInputElement>(
    'button:not([type]),button[type="submit"],input[type="submit"]',
  );
  if (defaultButton === null) {
    form.requestSubmit();
    return;
  }
  if (!defaultButton.disabled) defaultButton.click();
}

/** Lets any request a submit may have started reach the mocked client before asserting it did not. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("shows the default expiry as its label in the closed Expires trigger", () => {
  renderDialog();
  expect(
    screen.getByRole("combobox", { name: "Expires" }).querySelector('[data-slot="select-value"]')
      ?.textContent,
  ).toBe("90 days");
});

it("creates the token when Enter is pressed in the name field", async () => {
  const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(RESULT);
  const { input, onCreated } = renderDialog();
  fireEvent.change(input, { target: { value: "  Claude  " } });
  pressEnter(input);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledWith({
    name: "Claude",
    expiresInDays: 90,
    identityId: RESULT.item.identityId,
    access: { mode: "read", paths: ["/"] },
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(RESULT));
});

it("creates the token when the button is clicked", async () => {
  const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(RESULT);
  const { input, onCreated } = renderDialog();
  fireEvent.change(input, { target: { value: "Claude" } });
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledWith({
    name: "Claude",
    expiresInDays: 90,
    identityId: RESULT.item.identityId,
    access: { mode: "read", paths: ["/"] },
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(RESULT));
});

it("does not create a token from a blank or whitespace-only name", async () => {
  const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(RESULT);
  const { input } = renderDialog();
  pressEnter(input);
  fireEvent.change(input, { target: { value: "   " } });
  expect(screen.getByRole("button", { name: "Create token" }).hasAttribute("disabled")).toBe(true);
  pressEnter(input);
  const form = input.form;
  if (form !== null) fireEvent.submit(form);
  await flush();
  expect(create).not.toHaveBeenCalled();
});

it("does not send a second request while the first one is pending", async () => {
  let resolve: ((response: CreateApiTokenResponse) => void) | undefined;
  const create = vi.spyOn(apiClient, "createApiToken").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { input, onCreated } = renderDialog();
  fireEvent.change(input, { target: { value: "Claude" } });
  pressEnter(input);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const pendingButton = screen.getByRole("button", { name: "Creating…" });
  expect(pendingButton.hasAttribute("disabled")).toBe(true);
  pressEnter(input);
  const form = input.form;
  if (form !== null) fireEvent.submit(form);
  await flush();
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve?.(RESULT);
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(onCreated).toHaveBeenCalledTimes(1);
});

it("creates a token for the selected login", async () => {
  const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(RESULT);
  const { input } = renderDialog();
  fireEvent.change(input, { target: { value: "Personal assistant" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Login" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Personal · alice" }), {
    key: "Enter",
  });
  pressEnter(input);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      name: "Personal assistant",
      identityId: "33333333-3333-4333-8333-333333333333",
      expiresInDays: 90,
      access: { mode: "read", paths: ["/"] },
    }),
  );
});

it("creates a Full management token with specific folders", async () => {
  const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(RESULT);
  const { input } = renderDialog();
  fireEvent.change(input, { target: { value: "Work assistant" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Access" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Full management" }), {
    key: "Enter",
  });
  fireEvent.change(screen.getByLabelText("Allowed folders"), { target: { value: "/docs\n/team" } });
  pressEnter(input);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      name: "Work assistant",
      identityId: RESULT.item.identityId,
      expiresInDays: 90,
      access: { mode: "full", paths: ["/docs", "/team"] },
    }),
  );
});

it("keeps invalid folder grants in the form instead of creating a token", async () => {
  const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(RESULT);
  const { input } = renderDialog();
  fireEvent.change(input, { target: { value: "Assistant" } });
  fireEvent.change(screen.getByLabelText("Allowed folders"), { target: { value: "relative" } });
  pressEnter(input);
  expect(await screen.findByText(/enter 1–32 folder paths/)).toBeDefined();
  await flush();
  expect(create).not.toHaveBeenCalled();
});
