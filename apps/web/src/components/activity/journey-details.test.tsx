// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JourneyDetails } from "./journey-details";

const mocks = vi.hoisted(() => ({ activityRequest: vi.fn() }));
vi.mock("@/lib/activity/api", () => ({ activityRequest: mocks.activityRequest }));
vi.mock("@/lib/api/auth-queries", () => ({
  useMe: () => ({ data: { account: { id: "account" } } }),
}));

const FILE_ID = "00000000-0000-4000-8000-0000000000f1";
const COPY_ID = "00000000-0000-4000-8000-0000000000f2";
const SOURCE_ID = "00000000-0000-4000-8000-0000000000f3";
const DERIVED_ID = "00000000-0000-4000-8000-0000000000f4";

function edge(index: number, overrides: Record<string, unknown>) {
  return {
    id: `00000000-0000-4000-8000-0000000000e${index}`,
    kind: "copy",
    sourceFileId: FILE_ID,
    targetFileId: COPY_ID,
    ...overrides,
  };
}

function revision(index: number, size: number | null, sha256: string | null) {
  return {
    id: `00000000-0000-4000-8000-0000000000a${index}`,
    eventId: `00000000-0000-4000-8000-0000000000b${index}`,
    size,
    sha256,
  };
}

/** Answers each journey request by its path, as the API would. */
function answer(responses: Record<string, unknown>) {
  mocks.activityRequest.mockImplementation(async (path: string) => {
    if (!(path in responses)) throw new Error(`unexpected request ${path}`);
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response;
  });
}

function renderJourney() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JourneyDetails fileId={FILE_ID} />
    </QueryClientProvider>,
  );
}

/** The block under a heading: its `PageSection`. */
function block(name: string): HTMLElement {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (section === null) throw new Error(`${name} has no block`);
  return section;
}

beforeEach(() => {
  mocks.activityRequest.mockReset();
});
afterEach(cleanup);

it("lists a file's related files and revision records in the open, as two blocks", async () => {
  answer({
    [`/files/${FILE_ID}/lineage`]: {
      items: [
        edge(1, { targetPath: "/docs/copy.txt" }),
        edge(2, {
          kind: "derived_from",
          sourceFileId: SOURCE_ID,
          targetFileId: FILE_ID,
          sourcePath: null,
        }),
        edge(3, { kind: "extracted", targetFileId: DERIVED_ID }),
      ],
      nextCursor: null,
    },
    [`/files/${FILE_ID}/revisions`]: {
      items: [revision(1, 2048, "abc123"), revision(2, null, null)],
      nextCursor: null,
    },
  });
  const view = renderJourney();

  const related = within(block("Related files"));
  const links = await related.findAllByRole("link");
  // Each related file leads to its own journey, named by its file where the path is known.
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["copy.txtcopy", `/activity/files/${COPY_ID}`],
    ["Source filederived from", `/activity/files/${SOURCE_ID}`],
    ["Derived fileextracted", `/activity/files/${DERIVED_ID}`],
  ]);
  expect(related.queryByText("No recorded copies or derived files.")).toBeNull();
  expect(related.queryByRole("button")).toBeNull();

  const revisions = within(block("Revision records"));
  expect(
    revisions.getByText("Evidence of each change. Earlier file contents are not stored."),
  ).toBeTruthy();
  const records = await revisions.findAllByRole("listitem");
  expect(records.map((record) => record.textContent)).toEqual([
    `${(2048).toLocaleString()} bytesSHA-256 abc123`,
    "Size unavailable",
  ]);
  expect(revisions.queryByText("No recorded revisions.")).toBeNull();

  // Nothing is folded away behind a disclosure.
  expect(view.container.querySelector("details, summary, [aria-expanded]")).toBeNull();
});

it("says when a file has no related files and no revisions", async () => {
  answer({
    [`/files/${FILE_ID}/lineage`]: { items: [], nextCursor: null },
    [`/files/${FILE_ID}/revisions`]: { items: [], nextCursor: null },
  });
  renderJourney();

  expect(await screen.findByText("No recorded copies or derived files.")).toBeTruthy();
  expect(await screen.findByText("No recorded revisions.")).toBeTruthy();
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
});

it("says when either list cannot be loaded", async () => {
  answer({
    [`/files/${FILE_ID}/lineage`]: new Error("offline"),
    [`/files/${FILE_ID}/revisions`]: new Error("offline"),
  });
  renderJourney();

  await waitFor(() =>
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
      "Could not load related files.",
      "Could not load revisions.",
    ]),
  );
  expect(screen.queryByText("No recorded copies or derived files.")).toBeNull();
  expect(screen.queryByText("No recorded revisions.")).toBeNull();
});

it("loads more related files and more revisions on request", async () => {
  answer({
    [`/files/${FILE_ID}/lineage`]: {
      items: [edge(1, { targetPath: "/docs/copy.txt" })],
      nextCursor: "next page",
    },
    [`/files/${FILE_ID}/lineage?cursor=next%20page`]: {
      items: [edge(2, { targetFileId: DERIVED_ID, targetPath: "/docs/second.txt" })],
      nextCursor: null,
    },
    [`/files/${FILE_ID}/revisions`]: { items: [revision(1, 10, null)], nextCursor: "r2" },
    [`/files/${FILE_ID}/revisions?cursor=r2`]: {
      items: [revision(2, 20, null)],
      nextCursor: null,
    },
  });
  renderJourney();

  fireEvent.click(await screen.findByRole("button", { name: "More related files" }));
  expect(await screen.findByRole("link", { name: /second\.txt/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /copy\.txt/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More related files" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "More revisions" }));
  expect(await screen.findByText("20 bytes")).toBeTruthy();
  expect(screen.getByText("10 bytes")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More revisions" })).toBeNull();
});
