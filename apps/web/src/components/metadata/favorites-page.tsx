"use client";

import { useFavorites, useToggleFavorite } from "@/lib/metadata/queries";
import { VirtualListing } from "./virtual-listing";

/** The `/favorites` page: every favorited path, in a read-only virtual listing. */
export function FavoritesPage() {
  const { data: items } = useFavorites();
  const toggleFavorite = useToggleFavorite();
  const paths = (items ?? []).map((item) => item.path);

  return (
    <VirtualListing
      title="Favorites"
      paths={paths}
      onRemoveMissing={(path) => toggleFavorite.mutate({ path, favorite: false })}
    />
  );
}
