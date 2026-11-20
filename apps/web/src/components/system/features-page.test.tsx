// @vitest-environment jsdom
import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  replace: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useSystemFeatures: () => mocks.query(),
  useUpdateFeatures: () => mocks.update(),
}));
vi.mock("./office-settings-card", () => ({
  OfficeSettingsCard: ({ onContinue }: { onContinue?: () => void }) => (
    <button type="button" onClick={onContinue}>
      Office settings
    </button>
  ),
  OfficeReview: () => <span>Office review</span>,
}));
vi.mock("./public-url-card", () => ({
  PublicUrlCard: ({ onContinue }: { onContinue?: () => void }) => (
    <button type="button" onClick={onContinue}>
      Address settings
    </button>
  ),
  PublicUrlReview: () => <span>Address review</span>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
const { SetupFeatures } = await import("./features-page");
const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};
function mount(step: number, complete = false, values = off) {
  const data: SystemFeaturesResponse = {
    configuration: {
      version: 1,
      revision: 4,
      values,
      walkthroughComplete: complete,
      walkthroughStep: step,
    },
    source: "settings",
    statuses: [],
  };
  mocks.query.mockReturnValue({ data, dataUpdatedAt: 1 });
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    isError: false,
  });
  return render(<SetupFeatures />);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("feature walkthrough", () => {
  it("includes separate search OCR and PDF conversion steps", () => {
    const view = mount(2);
    expect(screen.getByText(/Original files stay unchanged/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 4,
        walkthroughStep: 3,
        values: { ...off, textSearch: true, searchOcr: true },
      }),
      expect.anything(),
    );
    view.unmount();
    mount(5);
    expect(screen.getByText(/Modifies original PDFs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        walkthroughStep: 6,
        values: { ...off, textSearch: true, pdfOcr: true },
      }),
      expect.anything(),
    );
  });
  it("can skip a feature or finish with everything off", () => {
    const view = mount(4);
    fireEvent.click(screen.getByRole("button", { name: "Skip this feature" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 5, values: off }),
      expect.anything(),
    );
    view.unmount();
    mount(8);
    mocks.mutate.mockImplementationOnce((_input: unknown, options: { onSuccess: () => void }) =>
      options.onSuccess(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ walkthroughComplete: true, values: off }),
      expect.anything(),
    );
    expect(mocks.replace).toHaveBeenCalledWith("/files");
  });

  it("resumes the saved feature step and persists its required dependency", () => {
    mount(2);

    expect(screen.getByText("Step 5 of 11 · Search OCR")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Enable search ocr" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        walkthroughStep: 3,
        values: { ...off, textSearch: true, searchOcr: true },
      }),
      expect.anything(),
    );
  });
  it("has nothing left to choose once the walkthrough is finished", () => {
    mount(6, true);

    // The features' own System areas hold their switches from here on.
    expect(screen.getByRole("status").textContent).toBe("Opening your files…");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps the walkthrough free of links out of the setup screen", () => {
    mount(0);

    expect(screen.getByText("Set up fdrive")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("waits for the saved choices and offers a retry when they cannot be read", () => {
    mocks.query.mockReturnValue({ data: undefined });
    const view = render(<SetupFeatures />);
    expect(screen.getByRole("status").textContent).toBe("Loading your setup…");
    view.unmount();

    mocks.query.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error("offline"),
      refetch: mocks.refetch,
    });
    render(<SetupFeatures />);
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("asks for the server address after the features, with no Trash step, and before Office", () => {
    mount(6);
    expect(screen.getByText("Step 9 of 11 · Server address")).toBeTruthy();
    expect(screen.queryByText(/Trash/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save and continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Address settings" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 7, values: off }),
      expect.anything(),
    );
  });
  it("includes Office after the address and before review", () => {
    mount(7);
    expect(screen.getByText("Step 10 of 11 · Office")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Office settings" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 8, values: off }),
      expect.anything(),
    );
  });
  it("reviews the address alongside the other choices", () => {
    mount(8);
    expect(screen.getByText("Step 11 of 11 · Review")).toBeTruthy();
    expect(screen.getByText("Address review")).toBeTruthy();
    // The Features page is gone: each feature is switched in its own System area.
    expect(screen.getByText(/later under System: each feature has its own switch/)).toBeTruthy();
    expect(screen.queryByText(/System: Features/)).toBeNull();
  });
  it("starts with features and hides storage work when everything is off", () => {
    mount(0);
    expect(screen.getByRole("switch", { name: "Enable thumbnails" })).toBeTruthy();
    expect(screen.queryByText("Check your storage")).toBeNull();
    expect(screen.queryByText("Advanced storage settings")).toBeNull();
  });

  it("does not ask for storage configuration even when processing has been enabled", () => {
    mount(1, false, { ...off, thumbnails: true });
    expect(screen.queryByText("Advanced storage settings")).toBeNull();
    expect(screen.queryByText(/Map your account/)).toBeNull();
    expect(screen.queryByText(/Storage mapping/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeTruthy();
  });
});
