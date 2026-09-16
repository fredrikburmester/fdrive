// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { loadOrganizeSharing, ORGANIZE_SHARING_KEY, saveOrganizeSharing } from "./organize-sharing";

afterEach(() => window.localStorage.clear());

it("shares everything until a choice is remembered, then round-trips it", () => {
  expect(loadOrganizeSharing()).toEqual({ contents: true, otherFileNames: true });
  saveOrganizeSharing({ contents: false, otherFileNames: true });
  expect(window.localStorage.getItem(ORGANIZE_SHARING_KEY)).toBe(
    JSON.stringify({ contents: false, otherFileNames: true }),
  );
  expect(loadOrganizeSharing()).toEqual({ contents: false, otherFileNames: true });
});

it("ignores a remembered value it cannot read", () => {
  window.localStorage.setItem(ORGANIZE_SHARING_KEY, "not json");
  expect(loadOrganizeSharing()).toEqual({ contents: true, otherFileNames: true });
  window.localStorage.setItem(ORGANIZE_SHARING_KEY, JSON.stringify({ contents: "yes" }));
  expect(loadOrganizeSharing()).toEqual({ contents: true, otherFileNames: true });
});
