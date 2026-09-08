// @vitest-environment jsdom
import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  storageQuery: vi.fn(),
  identityScope: vi.fn(),
  setIdentityScope: vi.fn(),
  refetchStorage: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useSystemFeatures: () => mocks.query(),
  useUpdateFeatures: () => mocks.update(),
}));
vi.mock("./system-page", () => ({
  SystemPage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/shell/page-header", () => ({
  useShellMe: () => ({
    data: {
      activeIdentityId: "alice",
      identities: [{ id: "alice", username: "alice" }],
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => mocks.storageQuery() }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    identityScope: (...args: unknown[]) => mocks.identityScope(...args),
    setIdentityScope: (...args: unknown[]) => mocks.setIdentityScope(...args),
  },
}));
const { FeaturesPage } = await import("./features-page");
const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};
function mount(step: number, complete = false, roots: SystemFeaturesResponse["roots"] = []) {
  const data: SystemFeaturesResponse = {
    configuration: {
      version: 1,
      revision: 4,
      values: off,
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
  mocks.storageQuery.mockReturnValue({ data: { status: "available" }, isError: false });
});
describe("feature walkthrough", () => {
  it("includes separate search OCR and PDF conversion steps", () => {
    const view = mount(3);
    expect(screen.getByText(/Original files stay unchanged/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 4,
        walkthroughStep: 4,
        values: { ...off, textSearch: true, searchOcr: true },
      }),
      expect.anything(),
    );
    view.unmount();
    mount(6);
    expect(screen.getByText(/Modifies original PDFs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ walkthroughStep: 7, values: { ...off, pdfOcr: true } }),
      expect.anything(),
    );
  });
  it("can skip a feature or finish with everything off", () => {
    const view = mount(5);
    fireEvent.click(screen.getByRole("button", { name: "Skip this feature" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 6, values: off }),
      expect.anything(),
    );
    view.unmount();
    mount(7);
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
    mount(3);

    expect(screen.getByText("Step 4 of 8 · Search OCR")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Enable search ocr" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        walkthroughStep: 4,
        values: { ...off, textSearch: true, searchOcr: true },
      }),
      expect.anything(),
    );
  });
  it("shows all six controls after setup and supports restarting the walkthrough", () => {
    mount(7, true);
    expect(screen.getAllByRole("switch")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Run walkthrough" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughStep: 0, walkthroughComplete: false }),
      expect.anything(),
    );
  });
  it("explains a missing processing mount while browsing remains available", () => {
    mount(0);
    expect(screen.getByText(/No processing roots are configured/)).toBeTruthy();
    expect(screen.getByText(/Storage mapping verified/)).toBeTruthy();
  });

  it("shows indexing access separately from PDF write access", () => {
    mount(0, false, [
      {
        name: "sftpgo",
        sftpgoPath: "/data",
        indexerPath: "/roots/sftpgo",
        processing: { indexReadable: true, pdfReadable: true, pdfWritable: false },
      },
    ]);
    expect(screen.getByText("Indexing: readable.")).toBeTruthy();
    expect(screen.getByText("PDF conversion: needs readable and writable storage.")).toBeTruthy();
  });

  it("saves an admin storage mapping from the storage step", async () => {
    const refetch = vi.fn();
    mocks.storageQuery.mockReturnValue({
      data: {
        isAdmin: true,
        status: "available",
        mappings: [
          { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
          { rootName: "shared", fsPrefix: "/team", virtualPrefix: "/team" },
        ],
      },
      isError: false,
      refetch,
    });
    mocks.setIdentityScope.mockResolvedValue({});
    mount(0, false, [
      { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
    ]);

    fireEvent.change(screen.getByLabelText("Home folder inside this root"), {
      target: { value: "/alice-documents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and verify mapping" }));

    await waitFor(() =>
      expect(mocks.setIdentityScope).toHaveBeenCalledWith("alice", {
        scopes: [
          { rootName: "sftpgo", fsPrefix: "/alice-documents", virtualPrefix: "/" },
          { rootName: "shared", fsPrefix: "/team", virtualPrefix: "/team" },
        ],
      }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
