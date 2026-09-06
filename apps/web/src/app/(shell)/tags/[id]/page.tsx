import { TagPage } from "@/components/metadata/tag-page";

interface TagRoutePageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function Page({ params }: TagRoutePageProps) {
  const { id } = await params;
  return <TagPage id={id} />;
}
