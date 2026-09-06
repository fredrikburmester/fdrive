import { FileWarningIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";

export interface TooLargeCardProps {
  readonly name: string;
  readonly downloadUrl: string;
}

/** Shown instead of the editor when the file is too large to edit inline. */
export function TooLargeCard({ name, downloadUrl }: TooLargeCardProps) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="max-w-sm">
        <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
          <FileWarningIcon className="size-8 text-muted-foreground" />
          <CardTitle>Too large to edit</CardTitle>
          <CardDescription>
            "{name}" is larger than 2 MiB, so fdrive cannot load it into the editor. Download it to
            edit it locally instead.
          </CardDescription>
          <Button nativeButton={false} render={<a href={downloadUrl} download={name} />}>
            Download
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
