import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon as FileGenericIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  MusicIcon,
  PresentationIcon,
  TableIcon,
  VideoIcon,
} from "lucide-react";
import { type FileIconInput, fileIconKind } from "@/lib/files/icon-kind";
import { cn } from "@/lib/utils";

const ICONS = {
  folder: FolderIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: MusicIcon,
  text: FileTextIcon,
  archive: FileArchiveIcon,
  code: FileCodeIcon,
  presentation: PresentationIcon,
  table: TableIcon,
  file: FileGenericIcon,
} as const;

export interface FileIconProps extends FileIconInput {
  className?: string;
}

/** Renders the lucide icon matching an entry's kind and extension. */
export function FileIcon({ className, ...entry }: FileIconProps) {
  const Icon = ICONS[fileIconKind(entry)];
  return (
    <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden="true" />
  );
}
