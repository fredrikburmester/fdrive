import type { FeatureId, FeatureValues } from "@fdrive/contracts";

export const FEATURE_DESCRIPTIONS: Record<
  FeatureId,
  { title: string; description: string; cost: string; dependency: string }
> = {
  thumbnails: {
    title: "Thumbnails",
    description: "Generate image and PDF previews for the file browser.",
    cost: "Uses disk space for cached previews.",
    dependency:
      "Requires mounted storage. Image search can generate its own internal previews when this is off.",
  },
  textSearch: {
    title: "Full-text search",
    description: "Find files by their names and document contents.",
    cost: "Reads your files and stores a searchable index.",
    dependency:
      "Requires mounted storage. Turning this off also turns off search OCR and semantic search.",
  },
  searchOcr: {
    title: "Search OCR",
    description:
      "Read text in scans and images so you can find it in fdrive. Original files stay unchanged.",
    cost: "Adds CPU work while indexing scans.",
    dependency: "Enabling this also enables full-text search.",
  },
  semanticSearch: {
    title: "Semantic search",
    description: "Find documents by meaning, even when the words differ.",
    cost: "Downloads a text model, uses memory, and stores embeddings.",
    dependency: "Enabling this also enables full-text search.",
  },
  imageSearch: {
    title: "Image search",
    description: "Find images by describing what they show.",
    cost: "Downloads an image model. Preparing an existing library can take time.",
    dependency:
      "Requires mounted storage and generates internal previews, independently of browser thumbnails.",
  },
  pdfOcr: {
    title: "Searchable PDFs",
    description: "Add a searchable text layer to PDFs stored in SFTPGo, for use in any PDF reader.",
    cost: "Modifies original PDFs and keeps backup originals by default, using additional disk space.",
    dependency: "Requires writable mounted storage. This is independent of search OCR.",
  },
};

export function changeFeature(
  values: FeatureValues,
  id: FeatureId,
  enabled: boolean,
): FeatureValues {
  const next = { ...values, [id]: enabled };
  if ((id === "searchOcr" || id === "semanticSearch") && enabled) next.textSearch = true;
  if (id === "textSearch" && !enabled) {
    next.searchOcr = false;
    next.semanticSearch = false;
  }
  return next;
}
