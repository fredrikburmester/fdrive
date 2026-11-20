import { ArrowUpRight, Coffee, GitFork, Laptop } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { PageBar, PageBody, PageSection, SettingRow } from "@/components/shell/page-layout";
import { serverApiClient } from "@/lib/api/server";
import { formatUptime } from "@/lib/system/format";
import { describeServerVersion } from "@/lib/system/server-version";

export const metadata: Metadata = { title: "About - fdrive" };

const GITHUB = "https://github.com/fredrikburmester/fdrive";
const docs = (path: string) => `${GITHUB}/blob/main/${path}`;
const guides = [
  ["Files, previews & sharing", "README.md#highlights"],
  ["Search & AI", "docs/SEARCH-AND-AI.md"],
  ["Indexing & thumbnails", "docs/INDEXER.md"],
  ["Searchable PDFs", "docs/OCR.md"],
  ["Office editing", "docs/OFFICE.md"],
  ["Trash & recovery", "docs/TRASH.md"],
  ["Accounts & sign-in", "docs/AUTH.md"],
  ["MCP integration", "docs/MCP.md"],
] as const;

/**
 * Links out of fdrive as a grid of cells divided by hairlines, which the grid clips at its own
 * edges: one column where the section is narrow, more as it widens.
 */
function ResourceGrid({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="resource-grid"
      className="grid overflow-hidden @xl:grid-cols-2 @4xl:grid-cols-3 @7xl:grid-cols-4"
    >
      {children}
    </div>
  );
}

function ResourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      data-slot="resource-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="-mr-px -mb-px flex min-h-11 min-w-0 items-center gap-2 border-border/60 border-r border-b px-3 text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none md:min-h-9"
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

export default async function AboutPage() {
  const client = await serverApiClient();
  const about = await client.about();
  const server = describeServerVersion(about);

  return (
    <>
      <PageHeader breadcrumbs={<h1 className="truncate font-medium text-sm">About</h1>} />
      <PageBody>
        <section aria-label="About fdrive" className="flex min-w-0 flex-1 flex-col">
          <PageBar>
            <span className="text-foreground">fdrive</span>
            <p>Your files, on your server. Browse, preview, search, and share.</p>
          </PageBar>
          <PageSection title="Server" description="The fdrive API this page was loaded from.">
            <SettingRow label="Server version">
              <span className="flex flex-wrap items-center gap-x-2 font-medium [overflow-wrap:anywhere]">
                <span>{server.label}</span>
                {server.revision !== null && (
                  <a
                    href={`${GITHUB}/commit/${server.revision}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={server.revision}
                    className="inline-flex items-center gap-1 font-mono text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-md:min-h-11"
                  >
                    {server.revision.slice(0, 12)}
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                  </a>
                )}
              </span>
            </SettingRow>
            <SettingRow
              label="API uptime"
              description="At page load. Resets when the API restarts."
            >
              <span className="font-medium tabular-nums">{formatUptime(about.uptimeSeconds)}</span>
            </SettingRow>
          </PageSection>
          <PageSection title="Project" description="Source, the Mac app and a way to say thanks.">
            <ResourceGrid>
              <ResourceLink href={GITHUB}>
                <GitFork aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                GitHub
              </ResourceLink>
              <ResourceLink href={docs("docs/MACOS.md")}>
                <Laptop aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                FDrive for macOS
              </ResourceLink>
              <ResourceLink href="https://buymeacoffee.com/fredrikbur3">
                <Coffee aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                Buy Me a Coffee
              </ResourceLink>
            </ResourceGrid>
          </PageSection>
          <PageSection
            title="Feature documentation"
            description="Setup, usage, and feature details on GitHub."
          >
            <ResourceGrid>
              {guides.map(([label, path]) => (
                <ResourceLink key={path} href={docs(path)}>
                  {label}
                </ResourceLink>
              ))}
            </ResourceGrid>
          </PageSection>
          <p className="px-3 py-2.5 text-muted-foreground text-xs [overflow-wrap:anywhere]">
            fdrive is licensed under the AGPL-3.0 license.
          </p>
        </section>
      </PageBody>
    </>
  );
}
