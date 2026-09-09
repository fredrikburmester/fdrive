// @vitest-environment jsdom
import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useSystemFeatures: () => mocks.query(),
  useUpdateFeatures: () => mocks.update(),
}));
vi.mock("./office-feature-card", () => ({
  OfficeFeatureCard: () => <p>Office feature card</p>,
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
vi.mock("./trash-settings-card", () => ({
  TrashSettingsCard: ({ onContinue }: { onContinue?: () => void }) => (
    <button type="button" onClick={onContinue}>
      Trash settings
    </button>
  ),
  TrashReview: () => <span>Trash review</span>,
}));
vi.mock("./system-page", () => ({
  SystemPage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
const { FeaturesPage } = await import("./features-page");
const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};
function mount(
  step: number,
  complete = false,
  roots: SystemFeaturesResponse["roots"] = [],
  values = off,
) {
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
    roots,
  };
  mocks.query.mockReturnValue({ data, dataUpdatedAt: 1 });
  mocks.update.mockReturnValue({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    isError: false,
  });
  return render(<FeaturesPage />);
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
      expect.objectContaining({ walkthroughStep: 6, values: { ...off, pdfOcr: true } }),
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
    mount(9);
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

    expect(screen.getByText("Step 6 of 13 · Search OCR")).toBeTruthy();
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
  it("shows all six controls after setup and supports restarting the walkthrough", () => {
    mount(6, true);
    expect(screen.getAllByRole("switch")).toHaveLength(6);
    expect(screen.getByText("Office feature card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trash settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Address settings" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Thumbnails" }).getAttribute("href")).toBe(
      "/system/thumbnails",
    );
    expect(screen.getByRole("link", { name: "Open Search" }).getAttribute("href")).toBe(
      "/system/search",
    );
    fireEvent.click(screen.getByRole("button", { name: "Run walkthrough" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 0, walkthroughComplete: false }),
      expect.anything(),
    );
  });
  it("keeps the walkthrough free of page links", () => {
    mount(0);

    expect(screen.queryByRole("link", { name: /^Open / })).toBeNull();
    expect(screen.queryByText("Office feature card")).toBeNull();
  });

  it("includes Trash before review without changing processing settings", () => {
    mount(6);
    expect(screen.getByText("Step 10 of 13 · Trash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trash settings" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 7, values: off }),
      expect.anything(),
    );
  });
  it("asks for the server address after Trash and before ONLYOFFICE", () => {
    mount(7);
    expect(screen.getByText("Step 11 of 13 · Server address")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Address settings" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 8, values: off }),
      expect.anything(),
    );
  });
  it("includes ONLYOFFICE after the address and before review", () => {
    mount(8);
    expect(screen.getByText("Step 12 of 13 · ONLYOFFICE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Office settings" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 9, values: off }),
      expect.anything(),
    );
  });
  it("reviews the address alongside the other choices", () => {
    mount(9);
    expect(screen.getByText("Step 13 of 13 · Review")).toBeTruthy();
    expect(screen.getByText("Address review")).toBeTruthy();
  });
  it("starts with features and hides storage work when everything is off", () => {
    mount(0);
    expect(screen.getByRole("switch", { name: "Enable thumbnails" })).toBeTruthy();
    expect(screen.queryByText("Check your storage")).toBeNull();
    expect(screen.queryByText("Advanced storage settings")).toBeNull();
    expect(screen.queryByText("Inspect SFTPGo users")).toBeNull();
  });

  it("does not ask for storage configuration even when processing has been enabled", () => {
    mount(
      1,
      false,
      [
        {
          name: "sftpgo",
          sftpgoPath: "/data",
          indexerPath: "/roots/sftpgo",
          processing: { indexReadable: true, pdfReadable: false, pdfWritable: false },
        },
      ],
      { ...off, thumbnails: true },
    );
    expect(screen.queryByText("Advanced storage settings")).toBeNull();
    expect(screen.queryByText(/Map your account/)).toBeNull();
    expect(screen.queryByText(/Storage mapping/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeTruthy();
  });
});
