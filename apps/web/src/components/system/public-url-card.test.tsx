// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/api/public-url-queries", () => ({
  useSystemPublicUrl: () => mocks.query(),
  useUpdatePublicUrl: () => mocks.update(),
}));
const { PublicUrlCard, PublicUrlReview } = await import("./public-url-card");
const { SystemCardSurface } = await import("./system-section");
beforeEach(() => {
  mocks.query.mockReturnValue({ data: { revision: 2, url: null }, refetch: mocks.refetch });
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
const field = () => screen.getByLabelText("Server address") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save and continue" }) as HTMLButtonElement;

it("prefills the browser's own address when none is saved and advances after saving", () => {
  const next = vi.fn();
  render(<PublicUrlCard onContinue={next} />);
  expect(field().value).toBe(window.location.origin);
  fireEvent.click(save());
  expect(mocks.mutate).toHaveBeenCalledWith(
    { revision: 2, url: window.location.origin },
    expect.anything(),
  );
  expect(next).not.toHaveBeenCalled();
  act(() => mocks.mutate.mock.calls[0]?.[1].onSuccess());
  expect(next).toHaveBeenCalledOnce();
});

it("shows the saved address and continues without a write when it is unchanged", () => {
  mocks.query.mockReturnValue({ data: { revision: 3, url: "https://files.example" } });
  const next = vi.fn();
  render(<PublicUrlCard onContinue={next} />);
  expect(field().value).toBe("https://files.example");
  fireEvent.click(save());
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});

it("normalises a trailing slash and blocks addresses with a path", () => {
  render(<PublicUrlCard onContinue={vi.fn()} />);
  fireEvent.change(field(), { target: { value: "https://drive.example/" } });
  fireEvent.click(save());
  expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ revision: 2, url: "https://drive.example" });
  fireEvent.change(field(), { target: { value: "https://drive.example/files" } });
  expect(save().disabled).toBe(true);
  expect(screen.getByRole("alert")).toBeTruthy();
});

it("lets the owner continue past an unavailable settings endpoint", () => {
  const next = vi.fn();
  mocks.query.mockReturnValue({
    isError: true,
    error: new Error("offline"),
    refetch: mocks.refetch,
  });
  render(<PublicUrlCard onContinue={next} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue without changing the address" }));
  expect(next).toHaveBeenCalledOnce();
});

it("preserves errors and lets the owner reload the saved address", () => {
  mocks.update.mockReturnValue({
    isError: true,
    error: new Error("Conflict"),
    mutate: mocks.mutate,
    reset: mocks.reset,
  });
  render(<PublicUrlCard />);
  expect(screen.getByRole("button", { name: "Save server address" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved address" }));
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

it("is a flat row on System > General, with the field and its Save side by side", () => {
  const { container } = render(<PublicUrlCard />);

  const row = container.querySelector('[data-slot="setting-row"]') as HTMLElement;
  expect(row.contains(field())).toBe(true);
  expect(row.contains(screen.getByRole("button", { name: "Save server address" }))).toBe(true);
  expect(container.querySelector('[data-slot="card"]')).toBeNull();
  expect(screen.getByText(/Behind an HTTPS reverse proxy/)).toBeTruthy();
});

it("stays a card in the setup walkthrough, through loading, a bad address and a failed read", () => {
  const next = vi.fn();
  const view = render(
    <SystemCardSurface>
      <PublicUrlCard onContinue={next} />
    </SystemCardSurface>,
  );
  expect(view.container.querySelector('[data-slot="card"]')).not.toBeNull();
  expect(view.container.querySelector('[data-slot="setting-row"]')).toBeNull();
  expect(screen.getByText(/Behind an HTTPS reverse proxy/)).toBeTruthy();
  fireEvent.change(field(), { target: { value: "https://drive.example/files" } });
  expect(screen.getByRole("alert").textContent).toContain("without a path");
  expect(save().disabled).toBe(true);
  view.unmount();

  mocks.query.mockReturnValue({ data: undefined, refetch: mocks.refetch });
  const loading = render(
    <SystemCardSurface>
      <PublicUrlCard onContinue={next} />
    </SystemCardSurface>,
  );
  expect(screen.getByRole("status").textContent).toBe("Loading server address…");
  loading.unmount();

  mocks.query.mockReturnValue({
    isError: true,
    error: new Error("offline"),
    refetch: mocks.refetch,
  });
  render(
    <SystemCardSurface>
      <PublicUrlCard onContinue={next} />
    </SystemCardSurface>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue without changing the address" }));
  expect(next).toHaveBeenCalledOnce();
});

it("says it is loading on the page too", () => {
  mocks.query.mockReturnValue({ data: undefined, refetch: mocks.refetch });
  render(<PublicUrlCard />);

  expect(screen.getByRole("status").textContent).toBe("Loading server address…");
});

it("reviews the saved address", () => {
  mocks.query.mockReturnValue({ data: { revision: 1, url: "https://files.example" } });
  render(<PublicUrlReview />);
  expect(screen.getByText("https://files.example")).toBeTruthy();
  cleanup();
  mocks.query.mockReturnValue({ data: { revision: 0, url: null } });
  render(<PublicUrlReview />);
  expect(screen.getByText("Not set")).toBeTruthy();
});
