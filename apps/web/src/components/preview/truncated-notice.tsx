/** Shown above a text-like preview when the file was too large to load in full. */
export function TruncatedNotice() {
  return (
    <div className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
      Showing the first 2 MiB of this file.
    </div>
  );
}
