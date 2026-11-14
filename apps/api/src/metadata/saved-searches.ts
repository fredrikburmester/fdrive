import {
  CreateSavedSearchRequest,
  type OkResponse,
  ROUTES,
  type SavedSearch,
  type SavedSearchesResponse,
} from "@fdrive/contracts";
import type { SavedSearchRepo } from "@fdrive/db";
import type { AuthedHono } from "../app.js";
import { normalizeOrThrow, parseBody } from "../fs/routes.js";

const BASE = ROUTES.savedSearches.slice("/api/v1".length);

/**
 * Saved searches belong to the caller's account and only ever reach it. They
 * hold a query and filters, never files: opening one runs the ordinary search
 * route, which applies the caller's index scopes and live permissions.
 */
export function registerSavedSearchRoutes(
  groups: { authed: AuthedHono },
  deps: { savedSearches: SavedSearchRepo },
): void {
  const { authed } = groups;

  authed.get(BASE, async (c) => {
    const { accountId } = c.get("principal");
    const body: SavedSearchesResponse = { searches: await deps.savedSearches.list(accountId) };
    return c.json(body);
  });

  authed.post(BASE, async (c) => {
    const { accountId } = c.get("principal");
    const input = await parseBody(CreateSavedSearchRequest, c);
    const folder = input.folder === null ? null : normalizeOrThrow(input.folder);
    const body: SavedSearch = await deps.savedSearches.create(accountId, { ...input, folder });
    return c.json(body, 201);
  });

  authed.delete(`${BASE}/:id`, async (c) => {
    const { accountId } = c.get("principal");
    await deps.savedSearches.delete(c.req.param("id"), accountId);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
