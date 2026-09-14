/** Explicit coverage: adding a table without a policy prevents a successful backup. */
export const DURABLE_TABLES = [
  "app.providers",
  "app.accounts",
  "app.identities",
  "app.credentials",
  "app.api_tokens",
  "app.tags",
  "app.file_tags",
  "app.favorites",
  "app.folder_views",
  "app.recents",
  "app.shares",
  "app.settings",
  "app.office_files",
  "app.system_events",
  "app.desktop_items",
  "app.desktop_operations",
  "app.desktop_effects",
  "idx.roots",
  "idx.scans",
  "idx.moves",
  "idx.events",
  "idx.ocr_log",
  "idx.ocr_runs",
  "idx.processing_failures",
  "app.backup_configuration",
  "app.backup_destinations",
  "app.backup_runs",
  "app.backup_deliveries",
  "app.backup_attachments",
] as const;
export const OMITTED_TABLES = {
  "app.thumbnails": "rebuildable",
  "app.image_embeddings": "rebuildable",
  "idx.files": "rebuildable",
  "idx.chunks": "rebuildable",
  "app.sessions": "transient",
  "app.wopi_locks": "transient",
  "idx.schema_version": "migration",
} as const;
export type DurableTable = (typeof DURABLE_TABLES)[number];
export function assertCoverage(tables: string[]): void {
  const expected = new Set<string>([...DURABLE_TABLES, ...Object.keys(OMITTED_TABLES)]);
  const unknown = tables.filter((table) => !expected.has(table));
  const missing = [...expected].filter((table) => !tables.includes(table));
  if (unknown.length || missing.length)
    throw Error(
      `Backup schema coverage mismatch: unknown=${unknown.join(",")}; missing=${missing.join(",")}`,
    );
}
export function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw Error("Invalid database identifier");
  return `"${value}"`;
}
export function quoteTable(value: string): string {
  if (!(DURABLE_TABLES as readonly string[]).includes(value)) throw Error("Unknown backup table");
  return value.split(".").map(quoteIdentifier).join(".");
}
export const BACKUP_GATE = 736591204;
export const BACKUP_WORKER = 736591205;
