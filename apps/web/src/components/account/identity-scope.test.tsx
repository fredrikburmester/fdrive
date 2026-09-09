// @vitest-environment jsdom
import { ApiClientError, type IdentityScopeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { IdentityScope } from "./identity-scope";

const nonAdmin: IdentityScopeResponse = {
  status: "unavailable",
  reason: "unmapped_mount",
  usesOverride: false,
  virtualPrefixes: ["/"],
  unmappedMounts: [{ virtualPath: "/shared", kind: "dir" }],
  unverifiedPrefixes: [],
  unindexedPrefixes: [],
  warning: "Mappings are an authorization boundary.",
  isAdmin: false,
};

const admin: IdentityScopeResponse = {
  ...nonAdmin,
  isAdmin: true,
  configuredRoots: ["sftpgo"],
  mappings: [{ rootName: "sftpgo", fsPrefix: "/carol", virtualPrefix: "/" }],
  overrides: [],
  adoptedMappings: [],
};

const mapped: IdentityScopeResponse = {
  ...admin,
  status: "available",
  reason: "ok",
  usesOverride: true,
  virtualPrefixes: ["/", "/shared"],
  unmappedMounts: [],
  mappings: [
    { rootName: "sftpgo", fsPrefix: "/carol", virtualPrefix: "/" },
    { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
  ],
  overrides: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" }],
};

function renderScope() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IdentityScope identityId="id-1" username="carol" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(apiClient, "mountMappings").mockResolvedValue({ mappings: [] });
  vi.spyOn(apiClient, "identityScopeSuggestions").mockResolvedValue({ mounts: [] });
});

it("lists the unmapped mount for a non-administrator without any physical detail or actions", async () => {
  vi.spyOn(apiClient, "identityScope").mockResolvedValue(nonAdmin);
  renderScope();
  await waitFor(() => expect(screen.getByText("Unavailable")).toBeDefined());
  expect(screen.getByText(/is not indexed\. Ask an administrator/)).toBeDefined();
  expect(screen.getByText(/Map it, or mark it not indexed/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Map /shared" })).toBeNull();
  expect(screen.queryByText(/carol/)).toBeNull();
  expect(screen.queryByText(/sftpgo/)).toBeNull();
});

it("maps a mount from its prompt and renders the returned status without refetching", async () => {
  const get = vi.spyOn(apiClient, "identityScope").mockResolvedValue(admin);
  const put = vi.spyOn(apiClient, "setIdentityScope").mockResolvedValue(mapped);
  renderScope();
  await waitFor(() => expect(screen.getByRole("button", { name: "Map /shared" })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Map /shared" }));
  const form = screen.getByRole("form", { name: "Map /shared" });
  expect(form).toBeDefined();
  // Root defaults to the only configured root; an empty physical prefix never round-trips.
  fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
  expect(screen.getByText(/Enter the folder's path/)).toBeDefined();
  expect(put).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Physical prefix"), {
    target: { value: "/_folders/shared" },
  });
  // Untick "apply to every login" to save a per-login override instead.
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Apply to every login that mounts this folder" }),
  );
  expect(screen.getByText("Saved for this login only.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
  await waitFor(() => expect(screen.getByText("Available")).toBeDefined());
  expect(put).toHaveBeenCalledWith("id-1", {
    scopes: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" }],
    unindexedPrefixes: [],
  });
  expect(get).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByRole("button", { name: "Remove mapping /shared" })).toBeDefined();
  expect(screen.getByText("Mappings are an authorization boundary.")).toBeDefined();
});

it("acknowledges a mount as not indexed, keeping earlier acknowledgements", async () => {
  vi.spyOn(apiClient, "identityScope").mockResolvedValue({
    ...admin,
    unindexedPrefixes: ["/archive"],
  });
  const put = vi.spyOn(apiClient, "setIdentityScope").mockResolvedValue({
    ...mapped,
    virtualPrefixes: ["/"],
    mappings: admin.mappings,
    overrides: [],
    unindexedPrefixes: ["/archive", "/shared"],
  });
  renderScope();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Mark /shared not indexed" })).toBeDefined(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Mark /shared not indexed" }));
  await waitFor(() => expect(screen.getByText("Available")).toBeDefined());
  expect(put).toHaveBeenCalledWith("id-1", {
    scopes: [],
    unindexedPrefixes: ["/archive", "/shared"],
  });
  expect(screen.getByRole("button", { name: "Remove not indexed /shared" })).toBeDefined();
});

it("shows a save failure on the field it concerns", async () => {
  vi.spyOn(apiClient, "identityScope").mockResolvedValue(admin);
  vi.spyOn(apiClient, "setIdentityScope").mockRejectedValue(
    new ApiClientError("bad_request", "unknown root", 400, {
      details: { reason: "unknown_root" },
    }),
  );
  renderScope();
  await waitFor(() => expect(screen.getByRole("button", { name: "Map /shared" })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Map /shared" }));
  fireEvent.change(screen.getByLabelText("Physical prefix"), {
    target: { value: "/_folders/shared" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Apply to every login that mounts this folder" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
  await waitFor(() =>
    expect(screen.getByText("That root is not configured on this server.")).toBeDefined(),
  );
  expect(screen.getByRole("form", { name: "Map /shared" })).toBeDefined();
});

it("reports a scope that was dropped while the rest stayed available", async () => {
  vi.spyOn(apiClient, "identityScope").mockResolvedValue({
    ...nonAdmin,
    status: "available",
    reason: "ok",
    virtualPrefixes: ["/", "/team"],
    unmappedMounts: [],
    unverifiedPrefixes: ["/team"],
  });
  renderScope();
  await waitFor(() => expect(screen.getByText("Available")).toBeDefined());
  expect(screen.getByText(/Not verified, so excluded from search: \/team\./)).toBeDefined();
});

it("prefills from a suggestion and saves a folder mapping for every login by default", async () => {
  vi.spyOn(apiClient, "identityScope")
    .mockResolvedValueOnce(admin)
    .mockResolvedValue({
      ...mapped,
      overrides: [],
      adoptedMappings: [
        { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
      ],
    });
  vi.spyOn(apiClient, "mountMappings").mockResolvedValue({
    mappings: [{ virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/_folders/team" }],
  });
  vi.spyOn(apiClient, "identityScopeSuggestions").mockResolvedValue({
    mounts: [
      {
        virtualPath: "/shared",
        suggestions: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
      },
    ],
  });
  const putFolder = vi.spyOn(apiClient, "setMountMappings").mockResolvedValue({
    mappings: [
      { virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/_folders/team" },
      { virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" },
    ],
  });
  const putIdentity = vi.spyOn(apiClient, "setIdentityScope");
  renderScope();
  await waitFor(() => expect(screen.getByRole("button", { name: "Map /shared" })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Map /shared" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Use sftpgo:/_folders/shared" })).toBeDefined(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use sftpgo:/_folders/shared" }));
  expect((screen.getByLabelText("Physical prefix") as HTMLInputElement).value).toBe(
    "/_folders/shared",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
  await waitFor(() => expect(screen.getByText("Available")).toBeDefined());
  expect(putFolder).toHaveBeenCalledWith({
    mappings: [
      { virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/_folders/team" },
      { virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" },
    ],
  });
  expect(putIdentity).not.toHaveBeenCalled();
  expect(screen.getByText(/Shared folder mapping, managed under/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Remove mapping /shared" })).toBeNull();
});
