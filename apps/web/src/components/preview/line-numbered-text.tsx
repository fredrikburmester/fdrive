export interface LineNumberedTextProps {
  readonly text: string;
}

/** A monospace `<pre>` block with a right-aligned line-number gutter. */
export function LineNumberedText({ text }: LineNumberedTextProps) {
  const lines = text.split("\n");

  return (
    <pre className="min-w-full p-4 font-mono text-xs leading-6">
      <code>
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          return (
            <div key={lineNumber} className="flex gap-4">
              <span className="w-10 shrink-0 select-none text-right text-muted-foreground/60">
                {lineNumber}
              </span>
              <span className="whitespace-pre-wrap break-all">{line}</span>
            </div>
          );
        })}
      </code>
    </pre>
  );
}
