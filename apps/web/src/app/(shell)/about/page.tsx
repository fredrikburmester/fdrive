import { ArrowUpRight, Coffee, GitFork, Laptop } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { serverApiClient } from "@/lib/api/server";
import { providerTypeLabel } from "@/lib/identity/provider-type";
import { formatUptime } from "@/lib/system/format";

export const metadata: Metadata = { title: "About - fdrive" };

const GITHUB = "https://github.com/fredrikburmester/fdrive-web";
const docs = (path: string) => `${GITHUB}/blob/main/${path}`;
const guides = [
  ["Files, previews & sharing", "README.md#highlights"],
  ["Search & AI", "docs/SEARCH-AND-AI.md"],
  ["Indexing & thumbnails", "docs/INDEXER.md"],
  ["Searchable PDFs", "docs/OCR.md"],
  ["Office editing", "docs/OFFICE.md"],
  ["Trash & recovery", "docs/TRASH.md"],
  ["Accounts & sign-in", "docs/AUTH.md"],
  ["WebDAV storage", "docs/WEBDAV.md"],
  ["Shared folders", "docs/SCOPING.md#virtual-and-shared-folders"],
  ["MCP integration", "docs/MCP.md"],
] as const;

function ResourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

export default async function AboutPage() {
  const client = await serverApiClient();
  const about = await client.about();
  const isRevision = /^[a-f0-9]{40,64}$/i.test(about.version);

  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">About</span>} />
      <section
        aria-label="About fdrive"
        className="flex min-w-0 flex-1 flex-col items-center gap-6 p-4 sm:p-6"
      >
        <Card className="w-full max-w-3xl">
          <CardHeader>
            <CardTitle>
              <h1>fdrive</h1>
            </CardTitle>
            <CardDescription>
              Your files, on your server. Browse, preview, search, and share.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-muted-foreground">Server version</dt>
                <dd className="mt-1 font-medium [overflow-wrap:anywhere]">
                  {isRevision ? (
                    <a
                      href={`${GITHUB}/commit/${about.version}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={about.version}
                      className="inline-flex min-h-11 items-center gap-1 font-mono underline-offset-4 hover:underline"
                    >
                      {about.version.slice(0, 12)}
                      <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </a>
                  ) : about.version === "development" || about.version === "0.0.0" ? (
                    "Development (version unavailable)"
                  ) : (
                    about.version
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">API uptime</dt>
                <dd className="mt-1 flex min-h-11 items-center font-medium tabular-nums">
                  {about.uptimeSeconds === undefined
                    ? "Unavailable"
                    : formatUptime(about.uptimeSeconds)}
                </dd>
                <p className="text-xs text-muted-foreground">
                  At page load. Resets when the API restarts.
                </p>
              </div>
            </dl>
            <div className="grid gap-2 sm:grid-cols-3">
              <ResourceLink href={GITHUB}>
                <GitFork aria-hidden="true" className="size-4 shrink-0" />
                GitHub
              </ResourceLink>
              <ResourceLink href={docs("docs/MACOS.md")}>
                <Laptop aria-hidden="true" className="size-4 shrink-0" />
                FDrive for macOS
              </ResourceLink>
              <ResourceLink href="https://buymeacoffee.com/fredrikbur3">
                <Coffee aria-hidden="true" className="size-4 shrink-0" />
                Buy Me a Coffee
              </ResourceLink>
            </div>
          </CardContent>
        </Card>
        <Card className="w-full max-w-3xl">
          <CardHeader>
            <CardTitle>
              <h2>Feature documentation</h2>
            </CardTitle>
            <CardDescription>Setup, usage, and feature details on GitHub.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {guides.map(([label, path]) => (
              <ResourceLink key={path} href={docs(path)}>
                {label}
              </ResourceLink>
            ))}
          </CardContent>
        </Card>
        <div className="flex w-full max-w-3xl flex-col gap-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {about.providers
            .filter((provider) => provider.label !== null)
            .map((provider) => (
              <p key={`${provider.type}-${provider.label}`}>
                Connected to {providerTypeLabel(provider.type)} at {provider.label}.
              </p>
            ))}
          <p>fdrive is licensed under the AGPL-3.0 license.</p>
        </div>
      </section>
    </>
  );
}
