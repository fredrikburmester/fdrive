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
const field = () => screen.getByLabelText("fdrive public address") as HTMLInputElement;
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

it("reviews the saved address", () => {
  mocks.query.mockReturnValue({ data: { revision: 1, url: "https://files.example" } });
  render(<PublicUrlReview />);
  expect(screen.getByText("https://files.example")).toBeTruthy();
  cleanup();
  mocks.query.mockReturnValue({ data: { revision: 0, url: null } });
  render(<PublicUrlReview />);
  expect(screen.getByText("Not set")).toBeTruthy();
});
