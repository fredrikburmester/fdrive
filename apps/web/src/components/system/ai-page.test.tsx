// @vitest-environment jsdom
import type { AiSettings } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  mutate: vi.fn(),
  testMutate: vi.fn(),
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
vi.mock("./system-page", () => ({
  SystemPage: (props: { title: string; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{props.title}</h1>
      <div>{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));

const { AiSystemPage } = await import("./ai-page");

const claude: AiSettings = {
  revision: 2,
  enabled: true,
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

beforeEach(() => {
  withSettings(claude);
  mocks.update.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  mocks.test.mockReturnValue({
    mutate: mocks.testMutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    data: undefined,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("summarizes the saved provider and what leaves the server", () => {
  render(<AiSystemPage />);
  expect(screen.getByText("On")).toBeTruthy();
  expect(screen.getByText("Organize is available to everyone signed in.")).toBeTruthy();
  expect(screen.getByText("Anthropic (Claude)")).toBeTruthy();
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.getByText(/fdrive sends Claude \(Anthropic\) only what it needs/)).toBeTruthy();
});

it("checks the connection and shows the answer", () => {
  mocks.test.mockReturnValue({
    mutate: mocks.testMutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    data: { ok: false, message: "Anthropic rejected the API key." },
  });
  render(<AiSystemPage />);
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  expect(mocks.testMutate).toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("Anthropic rejected the API key.");
});

it("asks for a key before Anthropic can be checked or used", () => {
  withSettings({ ...claude, hasApiKey: false });
  render(<AiSystemPage />);
  expect(screen.getByText("Needs an API key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check connection" })).toHaveProperty("disabled", true);
});

it("saves a new model and key from the settings sheet", () => {
  render(<AiSystemPage />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-new" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(mocks.mutate).toHaveBeenCalledWith(
    {
      revision: 2,
      enabled: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: null,
      apiKey: "sk-ant-new",
    },
    expect.anything(),
  );
  mocks.mutate.mock.calls[0]?.[1].onSuccess();
  expect(mocks.success).toHaveBeenCalledWith("AI settings saved.");
});

it("removes a saved key only when asked, and then blocks turning Anthropic on", () => {
  render(<AiSystemPage />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove the saved key" }));
  expect(screen.getByText("Enter an Anthropic API key to turn AI on.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Keep the saved key" }));
  expect(screen.queryByText("Enter an Anthropic API key to turn AI on.")).toBeNull();
});

it("warns that editing a server address drops its saved key", () => {
  withSettings({
    ...claude,
    provider: "openai_compatible",
    model: "qwen3:32b",
    baseUrl: "http://ollama:11434/v1",
  });
  render(<AiSystemPage />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByText("Stored encrypted and never shown again.")).toBeTruthy();
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
});
