// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import { makeMe } from "@/test-fixtures/identity";
import { MeHydration } from "./me-hydration";

afterEach(cleanup);
it("seeds the signed-in account before any child renders", () => {
  const client = new QueryClient();
  const me = makeMe();
  function Child() {
    return <span>{client.getQueryData(queryKeys.auth.me()) === me ? "seeded" : "empty"}</span>;
  }
  render(
    <QueryClientProvider client={client}>
      <MeHydration me={me}>
        <Child />
      </MeHydration>
    </QueryClientProvider>,
  );
  expect(screen.getByText("seeded")).toBeDefined();
});
