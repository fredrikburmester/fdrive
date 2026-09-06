import type { Route } from "next";
import { redirect } from "next/navigation";

// `/files` is served by an optional catch-all route, which Next's typed
// routes only model as `/files/${string}`, not the bare path.
const FILES_ROUTE = "/files" as unknown as Route;

export default function Home() {
  redirect(FILES_ROUTE);
}
