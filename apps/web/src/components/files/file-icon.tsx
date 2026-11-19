import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon as FileGenericIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  LinkIcon,
  type LucideIcon,
  MusicIcon,
  PresentationIcon,
  TableIcon,
  TextAlignStartIcon,
  VideoIcon,
} from "lucide-react";
import { type FileIconInput, type FileIconKind, fileIconKind } from "@/lib/files/icon-kind";
import { cn } from "@/lib/utils";

/**
 * Each kind's icon and color. Folders take the theme's blue; media and documents take a hue
 * from the tag palette, so the colors are the same Apple-like set the tags use; plain text,
 * code, archives and anything unknown stay muted.
 */
const ICONS: Record<FileIconKind, { icon: LucideIcon; color: string }> = {
  folder: { icon: FolderIcon, color: "text-primary" },
  image: { icon: ImageIcon, color: "text-tag-purple" },
  video: { icon: VideoIcon, color: "text-tag-orange" },
  audio: { icon: MusicIcon, color: "text-tag-red" },
  pdf: { icon: FileTextIcon, color: "text-tag-red" },
  document: { icon: FileTextIcon, color: "text-tag-blue" },
  text: { icon: TextAlignStartIcon, color: "text-muted-foreground" },
  archive: { icon: FileArchiveIcon, color: "text-muted-foreground" },
  code: { icon: FileCodeIcon, color: "text-muted-foreground" },
  presentation: { icon: PresentationIcon, color: "text-tag-yellow" },
  table: { icon: TableIcon, color: "text-tag-green" },
  link: { icon: LinkIcon, color: "text-muted-foreground" },
  file: { icon: FileGenericIcon, color: "text-muted-foreground" },
};

export interface FileIconProps extends FileIconInput {
  className?: string;
}

/** Renders the lucide icon matching an entry's kind and extension, in that kind's color. */
export function FileIcon({ className, ...entry }: FileIconProps) {
  const kind = fileIconKind(entry);
  const { icon: Icon, color } = ICONS[kind];
  return (
    <Icon
      data-icon-kind={kind}
      className={cn("size-4 shrink-0", color, className)}
      aria-hidden="true"
    />
  );
}
