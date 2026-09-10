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
            {about.builtOn.map((attribution) => (
              <p key={attribution.name}>
                Built on{" "}
                <a
                  href={attribution.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {attribution.name}
                </a>
                .
              </p>
            ))}
            {about.providers
              .filter((provider) => provider.label !== null)
              .map((provider) => (
                <p key={`${provider.type}-${provider.label}`}>
                  Connected to {provider.type === "sftpgo" ? "SFTPGo" : provider.type} at{" "}
                  {provider.label}.
                </p>
              ))}
            <p>fdrive is licensed under the AGPL-3.0 license.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
