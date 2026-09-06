import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { serverApiClient } from "@/lib/api/server";

export const metadata: Metadata = {
  title: "About - fdrive",
};

export default async function AboutPage() {
  const client = await serverApiClient();
  const about = await client.about();

  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">About</span>} />
      <div className="flex flex-1 flex-col items-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>fdrive</CardTitle>
            <CardDescription>Version {about.version}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Built on{" "}
              <a
                href={about.builtOn.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                {about.builtOn.name}
              </a>
              .
            </p>
            {about.provider ? <p>Connected to SFTPGo at {about.provider.label}.</p> : null}
            <p>fdrive is licensed under the AGPL-3.0 license.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
