// @vitest-environment jsdom
import type { AiSettings } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  mutate: vi.fn(),
  testMutate: vi.fn(),
  testReset: vi.fn(),
  refetch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/ai/queries", () => ({
  useSystemAi: () => mocks.query(),
  useUpdateSystemAi: () => mocks.update(),
  useTestSystemAi: () => mocks.test(),
}));
// The sheet as `SystemPage` draws it. `data-enabled` records whether the page asked for the
// sheet's own off state, which would hide the settings.
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    badges?: ReactNode;
    actions?: ReactNode;
    enabled?: boolean;
    children: ReactNode;
  }) => (
    <div data-testid="sheet" data-enabled={String(props.enabled)}>
      <h1>{props.title}</h1>
      <div data-testid="badges">{props.badges}</div>
      <div>{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));

const { AiSystemPage } = await import("./ai-page");

const claude: AiSettings = {
  revision: 2,
  organize: true,
  chat: true,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  hasApiKey: true,
};

function withSettings(configuration: AiSettings) {
  mocks.query.mockReturnValue({
    data: { configuration },
    dataUpdatedAt: 1,
    isError: false,
    refetch: mocks.refetch,
  });
}

function withTest(result: Record<string, unknown>) {
  mocks.test.mockReturnValue({
    mutate: mocks.testMutate,
    reset: mocks.testReset,
    isPending: false,
    isError: false,
    data: undefined,
    ...result,
  });
}

const badges = () => within(screen.getByTestId("badges"));
const provider = (name: string) =>
  within(screen.getByRole("group", { name: "Provider" })).getByRole("button", { name });
const saveButton = () => screen.getByRole("button", { name: "Save" });
const testButton = () => screen.getByRole("button", { name: "Test connection" });

beforeEach(() => {
  withSettings(claude);
  mocks.update.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  withTest({});
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("summarizes the saved provider in the header and says what leaves the server", () => {
  render(<AiSystemPage />);
  expect(badges().getByText("On")).toBeTruthy();
  expect(badges().getByText("Anthropic (Claude)")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Organize" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(screen.getByRole("switch", { name: "Chat" }).getAttribute("aria-checked")).toBe("true");
  expect(provider("Anthropic").getAttribute("aria-pressed")).toBe("true");
  expect(provider("Mistral").getAttribute("aria-pressed")).toBe("false");
  expect(provider("OpenAI-compatible").getAttribute("aria-pressed")).toBe("false");
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("claude-opus-5");
  expect(screen.queryByLabelText("Base URL")).toBeNull();
  // The key itself never comes back: the row only says one is saved.
  expect(screen.getByText("Saved")).toBeTruthy();
  const key = screen.getByLabelText("API key") as HTMLInputElement;
  expect(key.value).toBe("");
  expect(key.getAttribute("placeholder")).toBe("Enter a new key to replace it");
  expect(screen.getByText(/fdrive sends Claude \(Anthropic\) only what it needs/)).toBeTruthy();
  expect(screen.getByText(/files anywhere in the drive that the assistant browses/)).toBeTruthy();
  // Nothing is edited, so nothing can be saved, and nothing is wrong.
  expect(saveButton()).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Reset" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps its settings on screen while Organize and Chat are off", () => {
  withSettings({ ...claude, organize: false, chat: false, hasApiKey: false });
  render(<AiSystemPage />);
  expect(badges().getByText("Off")).toBeTruthy();
  // The sheet's own off state would replace the settings, so the page does not ask for it.
  expect(screen.getByTestId("sheet").getAttribute("data-enabled")).toBe("undefined");
  expect(screen.getByRole("switch", { name: "Organize" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(screen.getByRole("switch", { name: "Chat" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByLabelText("Model")).toBeTruthy();
  expect(screen.getByLabelText("API key").getAttribute("placeholder")).toBe("sk-ant-…");
  expect(screen.queryByText("Saved")).toBeNull();
});

it("tests the connection and shows a failed answer", () => {
  withTest({ data: { ok: false, message: "Anthropic rejected the API key." } });
  render(<AiSystemPage />);
  fireEvent.click(testButton());
  expect(mocks.testMutate).toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("Anthropic rejected the API key.");
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.queryByText("Reachable")).toBeNull();
});

it("shows a connection that works", () => {
  withTest({ data: { ok: true, message: "Connected to Anthropic. Claude is available." } });
  render(<AiSystemPage />);
  expect(screen.getByRole("status").textContent).toBe(
    "Connected to Anthropic. Claude is available.",
  );
  expect(screen.getByText("Reachable")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says when the test itself could not be run, and while it runs", () => {
  withTest({ isError: true, error: new Error("fdrive is offline") });
  const view = render(<AiSystemPage />);
  expect(screen.getByRole("alert").textContent).toBe("fdrive is offline");
  expect(screen.getByText("Failed")).toBeTruthy();

  withTest({ isPending: true });
  view.rerender(<AiSystemPage />);
  expect(screen.getByRole("button", { name: "Testing…" })).toHaveProperty("disabled", true);
});

it("says what a test does before one has run", () => {
  render(<AiSystemPage />);
  expect(
    screen.getByText("Sends one short request to Claude (Anthropic) with the saved settings."),
  ).toBeTruthy();
  expect(testButton()).toHaveProperty("disabled", false);
});

it("asks for a key before Anthropic can be tested or used", () => {
  withSettings({ ...claude, hasApiKey: false });
  render(<AiSystemPage />);
  expect(badges().getByText("Needs an API key")).toBeTruthy();
  expect(screen.getByText("Organize and Chat stay hidden until an API key is saved.")).toBeTruthy();
  expect(screen.getByText("Enter an Anthropic API key to turn Organize or Chat on.")).toBeTruthy();
  expect(screen.getByText("Save an API key to test the connection.")).toBeTruthy();
  expect(testButton()).toHaveProperty("disabled", true);
});

it("turns chat on from its row, and saves it with the rest", () => {
  withSettings({ ...claude, chat: false });
  render(<AiSystemPage />);
  expect(badges().getByText("On")).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Chat" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  // Nothing is sent until Save: turning a feature on depends on the key beside it.
  expect(mocks.mutate).not.toHaveBeenCalled();
  fireEvent.click(saveButton());
  expect(mocks.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ organize: true, chat: true }),
    expect.anything(),
  );
});

it("saves a new model and key from their rows", () => {
  render(<AiSystemPage />);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-new" } });
  fireEvent.click(saveButton());

  expect(mocks.mutate).toHaveBeenCalledWith(
    {
      revision: 2,
      organize: true,
      chat: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: null,
      apiKey: "sk-ant-new",
    },
    expect.anything(),
  );
  mocks.mutate.mock.calls[0]?.[1].onSuccess();
  expect(mocks.success).toHaveBeenCalledWith("AI settings saved.");
  // An earlier test result described the settings that were just replaced.
  expect(mocks.testReset).toHaveBeenCalled();
});

it("reports a save the server refused", () => {
  render(<AiSystemPage />);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
  fireEvent.click(saveButton());
  mocks.mutate.mock.calls[0]?.[1].onError(new Error("AI settings changed in another session."));
  expect(mocks.error).toHaveBeenCalledWith("AI settings changed in another session.");
  expect(mocks.success).not.toHaveBeenCalled();
});

it("holds the test until an edit is saved or reset, since it tests what is saved", () => {
  render(<AiSystemPage />);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
  expect(testButton()).toHaveProperty("disabled", true);
  expect(screen.getByText("Save your changes to test them.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("claude-opus-5");
  expect(testButton()).toHaveProperty("disabled", false);
});

it("holds every control while a save is under way", () => {
  mocks.update.mockReturnValue({ mutate: mocks.mutate, isPending: true });
  render(<AiSystemPage />);
  expect(screen.getByLabelText("Model")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("API key")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Remove key" })).toHaveProperty("disabled", true);
});

it("removes a saved key only when asked, and then blocks turning Anthropic on", () => {
  render(<AiSystemPage />);
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  expect(screen.getByText("The saved key is removed when you save.")).toBeTruthy();
  expect(screen.queryByText("Saved")).toBeNull();
  expect(screen.getByText("Enter an Anthropic API key to turn Organize or Chat on.")).toBeTruthy();
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Keep key" }));
  expect(screen.queryByText("Enter an Anthropic API key to turn Organize or Chat on.")).toBeNull();
  expect(screen.getByText("Saved")).toBeTruthy();
});

it("removes a saved key once Organize and Chat are off", () => {
  render(<AiSystemPage />);
  fireEvent.click(screen.getByRole("switch", { name: "Organize" }));
  fireEvent.click(screen.getByRole("switch", { name: "Chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  fireEvent.click(saveButton());
  expect(mocks.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ organize: false, chat: false, apiKey: null }),
    expect.anything(),
  );
});

it("summarizes a saved Mistral configuration and blocks the test without its key", () => {
  withSettings({ ...claude, provider: "mistral", model: "mistral-large-latest", hasApiKey: false });
  render(<AiSystemPage />);
  expect(badges().getByText("Mistral")).toBeTruthy();
  expect(provider("Mistral").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText(/fdrive sends Mistral only what it needs/)).toBeTruthy();
  expect(badges().getByText("Needs an API key")).toBeTruthy();
  expect(testButton()).toHaveProperty("disabled", true);
});

it("switches to Mistral with its default model, no base URL and a required key", () => {
  render(<AiSystemPage />);
  fireEvent.click(provider("Mistral"));

  expect(provider("Mistral").getAttribute("aria-pressed")).toBe("true");
  // The header still names what is saved.
  expect(badges().getByText("Anthropic (Claude)")).toBeTruthy();
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("mistral-large-latest");
  expect(screen.getByText("A Mistral model ID that supports tool calling.")).toBeTruthy();
  expect(screen.queryByLabelText("Base URL")).toBeNull();
  expect(screen.getByLabelText("API key").getAttribute("placeholder")).toBe("Required");
  expect(screen.getByText("Changing the provider or base URL removes the saved key.")).toBeTruthy();
  expect(screen.queryByText("Saved")).toBeNull();
  expect(screen.getByText("Enter a Mistral API key to turn Organize or Chat on.")).toBeTruthy();
  expect(saveButton()).toHaveProperty("disabled", true);

  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "mistral-key" } });
  fireEvent.click(saveButton());
  expect(mocks.mutate).toHaveBeenCalledWith(
    {
      revision: 2,
      organize: true,
      chat: true,
      provider: "mistral",
      model: "mistral-large-latest",
      baseUrl: null,
      apiKey: "mistral-key",
    },
    expect.anything(),
  );
});

it("asks for a base URL when the provider is a server you host", () => {
  render(<AiSystemPage />);
  fireEvent.click(provider("OpenAI-compatible"));

  expect(screen.getByLabelText("API key").getAttribute("placeholder")).toBe("Optional");
  expect(
    screen.getByText("Enter the server's base URL, starting with http:// or https://."),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "http://ollama:11434/v1" },
  });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen3:32b" } });
  fireEvent.click(saveButton());
  expect(mocks.mutate).toHaveBeenCalledWith(
    {
      revision: 2,
      organize: true,
      chat: true,
      provider: "openai_compatible",
      model: "qwen3:32b",
      baseUrl: "http://ollama:11434/v1",
    },
    expect.anything(),
  );
});

it("warns that editing a server address drops its saved key", () => {
  withSettings({
    ...claude,
    provider: "openai_compatible",
    model: "qwen3:32b",
    baseUrl: "http://ollama:11434/v1",
  });
  render(<AiSystemPage />);
  expect(badges().getByText("OpenAI-compatible server")).toBeTruthy();
  expect(screen.getByText("Stored encrypted and never shown again.")).toBeTruthy();
  expect(
    screen.getByText("Sends one short request to your AI server with the saved settings."),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://llm:8000/v1" } });
  expect(screen.getByText("Changing the provider or base URL removes the saved key.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "llm:8000" } });
  expect(
    screen.getByText("Enter the server's base URL, starting with http:// or https://."),
  ).toBeTruthy();
});

it("shows loading and error states", () => {
  mocks.query.mockReturnValue({ data: undefined, dataUpdatedAt: 0, isError: false });
  render(<AiSystemPage />);
  expect(screen.getByText("Loading AI settings…")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  cleanup();
  mocks.query.mockReturnValue({
    data: undefined,
    dataUpdatedAt: 0,
    isError: true,
    error: new Error("boom"),
    refetch: mocks.refetch,
  });
  render(<AiSystemPage />);
  expect(screen.queryByText("Loading AI settings…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});
