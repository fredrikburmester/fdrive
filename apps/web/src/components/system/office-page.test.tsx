// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  address: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  reset: vi.fn(),
  success: vi.fn(),
  users: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: (m: string) => mocks.success(m) } }));
vi.mock("@/lib/api/office-settings-queries", () => ({
  useSystemOffice: () => mocks.query(),
  useUpdateOfficeSettings: () => mocks.update(),
}));
vi.mock("@/lib/api/public-url-queries", () => ({ useSystemPublicUrl: () => mocks.address() }));
vi.mock("@/lib/api/system-queries", () => ({ useAdminUsers: () => mocks.users() }));
vi.mock("./log-sheet", () => ({ LogSheet: () => <button type="button">Logs</button> }));
// The sheet as `SystemPage` draws it: the switch always, and while the area is off its note in
// place of the badges, actions, content and footer.
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    badges?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    enabled?: boolean;
    toggle?: ReactNode;
    offNote?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      {props.enabled === undefined ? null : (
        <p data-testid="state">{props.enabled ? "On" : "Off"}</p>
      )}
      <div data-testid="toggle">{props.toggle}</div>
      {props.enabled === false ? (
        <div data-testid="off">
          <p>{props.title} is off</p>
          {props.offNote}
        </div>
      ) : (
        <>
          <div data-testid="badges">{props.badges}</div>
          <div data-testid="actions">{props.actions}</div>
          <div data-testid="content">{props.children}</div>
          <div data-testid="footer">{props.footer}</div>
        </>
      )}
    </div>
  ),
}));

const { OfficeSystemPage } = await import("./office-page");

const enabled = {
  revision: 2,
  enabled: true,
  editingEnabled: true,
  editorUsernames: ["alice", "bob"],
};
const off = { revision: 2, enabled: false, editingEnabled: false, editorUsernames: [] };

function response(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      configuration: enabled,
      product: "onlyoffice",
      status: "ready",
      ...overrides,
    },
    dataUpdatedAt: 1,
    refetch: mocks.refetch,
  };
}

const officeSwitch = () => screen.getByRole("switch", { name: "Enable ONLYOFFICE" });
const editingSwitch = () => screen.getByRole("switch", { name: "Allow document editing" });
const editor = (username: string) => screen.getByRole("checkbox", { name: username });
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const isDisabled = (control: HTMLElement) =>
  control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true";

beforeEach(() => {
  mocks.address.mockReturnValue({ data: { revision: 1, url: "https://files.example" } });
  mocks.users.mockReturnValue({
    data: { users: ["alice", "bob", "carol"].map((username) => ({ username })) },
  });
  mocks.query.mockReturnValue(response());
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    isError: false,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows the product and its state in the header, and who may edit as settings", () => {
  render(<OfficeSystemPage />);

  expect(screen.getByTestId("state").textContent).toBe("On");
  const badges = within(screen.getByTestId("badges"));
  expect(badges.getByText("Reachable")).toBeTruthy();
  expect(badges.getByText("ONLYOFFICE")).toBeTruthy();
  expect(within(screen.getByTestId("actions")).getByRole("button", { name: "Logs" })).toBeTruthy();
  expect(officeSwitch().getAttribute("aria-checked")).toBe("true");

  expect(editingSwitch().getAttribute("aria-checked")).toBe("true");
  const editors = within(screen.getByRole("group", { name: "Users allowed to edit" }));
  expect(editors.getAllByRole("checkbox")).toHaveLength(3);
  expect(editor("alice").getAttribute("aria-checked")).toBe("true");
  expect(editor("bob").getAttribute("aria-checked")).toBe("true");
  expect(editor("carol").getAttribute("aria-checked")).toBe("false");
  // Nothing has been edited yet, so there is nothing to save or reset.
  expect(saveButton().disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Reset" })).toHaveProperty("disabled", true);

  const footer = within(screen.getByTestId("footer"));
  expect(footer.getByText(/Close open documents before disabling/)).toBeTruthy();
  expect(footer.getByRole("link", { name: "Office setup instructions" })).toBeTruthy();
  // A reachable editor needs no further word.
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says everyone is view-only when editing is off, and that a starting editor resolves", () => {
  mocks.query.mockReturnValue(
    response({
      configuration: { ...enabled, editingEnabled: false, editorUsernames: [] },
      status: "starting",
    }),
  );
  render(<OfficeSystemPage />);

  expect(editingSwitch().getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(/When off, all documents open for viewing/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText("Unreachable")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/This resolves on its own/);
});

it("says when the editor cannot be reached", () => {
  mocks.query.mockReturnValue(response({ status: "unavailable" }));
  render(<OfficeSystemPage />);

  expect(screen.getByText("Unreachable")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(
    "Unable to reach ONLYOFFICE. Check its container and the setup guide.",
  );
});

it("names Collabora when that is the configured product", () => {
  mocks.query.mockReturnValue(response({ product: "collabora" }));
  render(<OfficeSystemPage />);

  expect(within(screen.getByTestId("badges")).getByText("Collabora")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Enable Collabora" })).toBeTruthy();
});

it("replaces the page when Office is turned off, and says what turning it on does", () => {
  mocks.query.mockReturnValue(response({ configuration: off, status: "off" }));
  render(<OfficeSystemPage />);

  expect(screen.getByTestId("state").textContent).toBe("Off");
  const note = within(screen.getByTestId("off"));
  expect(note.getByText("Office is off")).toBeTruthy();
  expect(note.getByText(/Turning it on starts the bundled ONLYOFFICE editor/)).toBeTruthy();
  expect(note.getByRole("link", { name: "Office setup instructions" })).toBeTruthy();
  expect(officeSwitch().getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByRole("switch", { name: "Allow document editing" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("turns Office on at once from its switch", () => {
  mocks.query.mockReturnValue(response({ configuration: off, status: "off" }));
  render(<OfficeSystemPage />);

  fireEvent.click(officeSwitch());

  expect(mocks.mutate).toHaveBeenCalledWith({ ...off, enabled: true }, expect.anything());
});

it("turns Office off at once without touching the saved editor grants", () => {
  render(<OfficeSystemPage />);
  // An edit that was never saved does not ride along with the switch.
  fireEvent.click(editor("carol"));
  expect(editor("carol").getAttribute("aria-checked")).toBe("true");

  fireEvent.click(officeSwitch());

  expect(mocks.mutate).toHaveBeenCalledWith({ ...enabled, enabled: false }, expect.anything());
  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  expect(editor("carol").getAttribute("aria-checked")).toBe("false");
});

it("turns Office off when the only saved editor is no longer a user", () => {
  mocks.query.mockReturnValue(
    response({ configuration: { ...enabled, editorUsernames: ["removed"] } }),
  );
  render(<OfficeSystemPage />);

  fireEvent.click(officeSwitch());

  expect(mocks.mutate).toHaveBeenCalledWith(
    { revision: 2, enabled: false, editingEnabled: false, editorUsernames: [] },
    expect.anything(),
  );
});

it("holds its switches while a save is under way", () => {
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: true,
    isError: false,
  });
  render(<OfficeSystemPage />);

  expect(isDisabled(officeSwitch())).toBe(true);
  expect(isDisabled(editingSwitch())).toBe(true);
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
});

it("refuses to turn Office on without a server address, and points at General", () => {
  mocks.address.mockReturnValue({ data: { revision: 0, url: null } });
  mocks.query.mockReturnValue(response({ configuration: off, status: "off" }));
  render(<OfficeSystemPage />);

  expect(isDisabled(officeSwitch())).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Set the fdrive server address first");
  expect(screen.getByRole("link", { name: "Open General" }).getAttribute("href")).toBe(
    "/system/general",
  );
  fireEvent.click(officeSwitch());
  expect(mocks.mutate).not.toHaveBeenCalled();
});

it("edits and saves the editor list from the sheet's own rows", () => {
  render(<OfficeSystemPage />);

  fireEvent.click(editor("bob"));
  fireEvent.click(editor("carol"));
  fireEvent.click(saveButton());

  expect(mocks.mutate).toHaveBeenCalledWith(
    { ...enabled, editorUsernames: ["alice", "carol"] },
    expect.anything(),
  );

  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  expect(mocks.success).toHaveBeenCalledWith("ONLYOFFICE settings saved.");
  // The draft is gone: the rows show what the server has again.
  expect(saveButton().disabled).toBe(true);
});

it("asks for at least one user before editing can be saved", () => {
  mocks.query.mockReturnValue(
    response({ configuration: { ...enabled, editingEnabled: false, editorUsernames: [] } }),
  );
  render(<OfficeSystemPage />);

  fireEvent.click(editingSwitch());

  expect(screen.getByRole("alert").textContent).toBe(
    "When editing is enabled, choose at least one user.",
  );
  expect(saveButton().disabled).toBe(true);

  fireEvent.click(editor("carol"));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(saveButton());
  expect(mocks.mutate).toHaveBeenCalledWith(
    { ...enabled, editingEnabled: true, editorUsernames: ["carol"] },
    expect.anything(),
  );
});

it("resets an edit to what is saved", () => {
  render(<OfficeSystemPage />);

  fireEvent.click(editor("carol"));
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));

  expect(editor("carol").getAttribute("aria-checked")).toBe("false");
  expect(saveButton().disabled).toBe(true);
});

it("blocks a save while Office is on without a server address", () => {
  mocks.address.mockReturnValue({ data: { revision: 0, url: null } });
  render(<OfficeSystemPage />);

  fireEvent.click(editor("carol"));

  expect(saveButton().disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Set the fdrive server address first");
  // Turning it off stays possible.
  expect(isDisabled(officeSwitch())).toBe(false);
});

it("shows a refused save and reloads the saved settings", () => {
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    isError: true,
    error: new Error("Office settings changed in another session."),
  });
  render(<OfficeSystemPage />);

  expect(screen.getByRole("alert").textContent).toContain(
    "Office settings changed in another session.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

it("shows a refused switch in the off state too", () => {
  mocks.query.mockReturnValue(response({ configuration: off, status: "off" }));
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    isError: true,
    error: new Error("Set the fdrive server address before enabling Office."),
  });
  render(<OfficeSystemPage />);

  expect(within(screen.getByTestId("off")).getByRole("alert").textContent).toContain(
    "Set the fdrive server address before enabling Office.",
  );
});

it("shows loading and error states without an On or Off state", () => {
  mocks.query.mockReturnValue({ data: undefined, dataUpdatedAt: 0, refetch: mocks.refetch });
  render(<OfficeSystemPage />);
  expect(screen.getByRole("status").textContent).toBe("Loading Office settings…");
  expect(screen.queryByTestId("state")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  cleanup();

  mocks.query.mockReturnValue({
    data: undefined,
    dataUpdatedAt: 0,
    isError: true,
    error: new Error("offline"),
    refetch: mocks.refetch,
  });
  render(<OfficeSystemPage />);
  expect(screen.getByRole("alert").textContent).toContain("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});
