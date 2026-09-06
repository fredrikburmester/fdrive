import { fetchApiHealth } from "@/lib/api-health";

export default async function Home() {
  const baseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
  const health = await fetchApiHealth(fetch, baseUrl);
  const status = health.ok ? `API: ok, version ${health.version}` : "API unreachable";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-2xl font-semibold">fdrive</h1>
      <p className="text-sm text-muted-foreground">{status}</p>
    </main>
  );
}
