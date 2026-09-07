// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { apiClient, getTabIdentity, pinTabIdentity, tabEventsUrl } from "@/lib/api/client";
import { MeHydration } from "./me-hydration";

function Child() {
  return <span>{apiClient.downloadUrl("/same")}</span>;
}
afterEach(() => {
  cleanup();
  pinTabIdentity(undefined);
});
it("pins the server-selected identity before any child can generate requests or URLs", () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MeHydration
        me={{
          account: { id: "a", displayName: "Ada" },
          identities: [],
          activeIdentityId: "one",
          isAdmin: false,
        }}
      >
        <Child />
      </MeHydration>
    </QueryClientProvider>,
  );
  expect(getTabIdentity()).toBe("one");
  expect(screen.getByText("/api/v1/fs/download?path=%2Fsame&identity=one")).toBeDefined();
  expect(tabEventsUrl()).toBe("/api/v1/events?identity=one");
});
