import type { Metadata } from "next";
import { FavoritesPage } from "@/components/metadata/favorites-page";

export const metadata: Metadata = {
  title: "Favorites · fdrive",
};

export default function Page() {
  return <FavoritesPage />;
}
