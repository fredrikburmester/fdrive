import type { AboutResponse } from "@fdrive/contracts";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { DetailSheet, type DetailSheetProps, SheetColumns } from "@/components/shell/list-sheet";
import { PageSection } from "@/components/shell/page-layout";
import { Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { formatUptime } from "@/lib/system/format";
import { describeServerVersion } from "@/lib/system/server-version";

const GITHUB = "https://github.com/fredrikburmester/fdrive";
const docs = (path: string) => `${GITHUB}/blob/main/${path}`;

const PROJECT_LINKS = [
  ["GitHub", GITHUB],
  ["FDrive for macOS", docs("docs/MACOS.md")],
  ["Buy Me a Coffee", "https://buymeacoffee.com/fredrikbur3"],
] as const;

const GUIDES = [
  ["Files, previews & sharing", "README.md#highlights"],
  ["Search & AI", "docs/SEARCH-AND-AI.md"],
  ["Indexing & thumbnails", "docs/INDEXER.md"],
  ["Searchable PDFs", "docs/OCR.md"],
  ["Office editing", "docs/OFFICE.md"],
  ["Trash & recovery", "docs/TRASH.md"],
  ["Accounts & sign-in", "docs/AUTH.md"],
  ["MCP integration", "docs/MCP.md"],
] as const;

/** A link out of fdrive as a quiet row: its name, an arrow, and a hairline under it. */
function ResourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      data-slot="resource-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-h-11 min-w-0 items-center justify-between gap-3 border-border border-b text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <ArrowUpRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
      />
    </a>
  );
}

/** The running API as named values: its version, the commit it was built from, and its uptime. */
function ServerFacts({ about }: { about: AboutResponse }) {
  const server = describeServerVersion(about);
  const facts: Fact[] = [{ label: "Version", value: server.label }];
  if (server.revision !== null) {
    facts.push({
      label: "Revision",
      value: (
        <a
          href={`${GITHUB}/commit/${server.revision}`}
          target="_blank"
          rel="noopener noreferrer"
          title={server.revision}
          // The line stays as tall as its neighbours; on a phone the tap target reaches past it.
          className="relative underline decoration-border underline-offset-4 outline-hidden hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-3"
        >
          <Code>{server.revision.slice(0, 12)}</Code>
        </a>
      ),
    });
  }
  facts.push({
    label: "API uptime",
    value: <span className="tabular-nums">{formatUptime(about.uptimeSeconds)}</span>,
  });
  return (
    <div className="flex flex-col gap-3">
      <FactList facts={facts} />
      <p className="text-muted-foreground text-xs">
        Uptime is read when this opens and resets when the API restarts.
      </p>
    </div>
  );
}

export interface AboutSheetProps extends Pick<DetailSheetProps, "titleAs" | "onClose"> {
  /** What `GET /about` answered, or `undefined` while that is not there; then pass `children`. */
  about: AboutResponse | undefined;
  /** Shown in place of the server's facts while `about` is not there: loading, or why not. */
  children?: ReactNode;
  className?: string;
}

/**
 * About fdrive, as a sheet: the wordmark and what fdrive is, the running server's version,
 * revision and uptime, then the project's links and the feature guides. Administrators see it as
 * the last System area, everyone else from the account menu, and `/about` shows it on its own.
 */
export function AboutSheet({ about, children, className, ...sheet }: AboutSheetProps) {
  return (
    <DetailSheet
      // The one place the display size is used. The heading still reads "About fdrive".
      title={
        <span className="block text-[44px] leading-none tracking-[-0.04em]">
          <span className="sr-only">About</span> fdrive
        </span>
      }
      lede={
        <span className="block pt-1.5 text-base">
          Your files, on your server. Browse, preview, search, and share.
        </span>
      }
      footer={
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          fdrive is licensed under the AGPL-3.0 license.
        </p>
      }
      className={className}
      {...sheet}
    >
      <SheetColumns className="border-border border-t pt-6">
        <PageSection title="Server">
          {about !== undefined ? <ServerFacts about={about} /> : children}
        </PageSection>
        <PageSection title="Project">
          <div className="flex flex-col">
            {PROJECT_LINKS.map(([label, href]) => (
              <ResourceLink key={href} href={href}>
                {label}
              </ResourceLink>
            ))}
          </div>
        </PageSection>
      </SheetColumns>
      {/* No hairline above: the rows over it already end in one. */}
      <PageSection title="Feature documentation">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-x-8">
          {GUIDES.map(([label, path]) => (
            <ResourceLink key={path} href={docs(path)}>
              {label}
            </ResourceLink>
          ))}
        </div>
      </PageSection>
    </DetailSheet>
  );
}
