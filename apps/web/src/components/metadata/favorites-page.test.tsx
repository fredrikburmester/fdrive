// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FavoritesPage } from "./favorites-page";

const mocks = vi.hoisted(() => ({
  favorites: [] as { path: string }[] | undefined,
  toggle: vi.fn(),
}));
vi.mock("@/lib/metadata/queries", () => ({
  useFavorites: () => ({ data: mocks.favorites }),
  useToggleFavorite: () => ({ mutate: mocks.toggle }),
}));
vi.mock("./virtual-listing", () => ({
  VirtualListing: (props: {
    title: string;
    paths: readonly string[];
    onRemoveMissing: (path: string) => void;
  }) => (
    <div>
      <h1>{props.title}</h1>
      {props.paths.map((path) => (
        <button key={path} type="button" onClick={() => props.onRemoveMissing(path)}>
          {path}
        </button>
      ))}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists the login's favorites in order and unfavorites a path that is gone", () => {
  mocks.favorites = [{ path: "/a #.txt" }, { path: "/docs" }];
  render(<FavoritesPage />);
  expect(screen.getByRole("heading", { name: "Favorites" })).toBeDefined();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "/a #.txt",
    "/docs",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "/docs" }));
  expect(mocks.toggle).toHaveBeenCalledWith({ path: "/docs", favorite: false });
});

it("lists nothing while favorites load", () => {
  mocks.favorites = undefined;
  render(<FavoritesPage />);
  expect(screen.queryAllByRole("button")).toEqual([]);
});
