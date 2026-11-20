"use client";

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
import { useListDesign } from "@/lib/files/use-list-design";
import { cn } from "@/lib/utils";

/**
 * Each kind's icon and its color in the beta file list. Folders take the theme's blue; media
 * and documents take a hue from the tag palette, so the colors are the same Apple-like set the
 * tags use; plain text, code, archives and anything unknown stay muted.
 */
const ICONS: Record<FileIconKind, { icon: LucideIcon; color: string }> = {
  folder: { icon: FolderIcon, color: "text-ring" },
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

/** The classic list's shapes where they differ, so switching back shows it as it was. */
const CLASSIC_SHAPES: Partial<Record<FileIconKind, LucideIcon>> = {
  text: FileTextIcon,
  pdf: FileGenericIcon,
  document: FileGenericIcon,
};

export interface FileIconProps extends FileIconInput {
  className?: string;
  /** The line weight, for an icon drawn large enough that lucide's default looks heavy. */
  strokeWidth?: number | undefined;
}

/**
 * Renders the lucide icon matching an entry's kind and extension: muted, or in that kind's
 * color while the File list setting is the beta.
 */
export function FileIcon({ className, strokeWidth, ...entry }: FileIconProps) {
  const [design] = useListDesign();
  const kind = fileIconKind(entry);
  const beta = design === "beta";
  const Icon = beta ? ICONS[kind].icon : (CLASSIC_SHAPES[kind] ?? ICONS[kind].icon);
  const color = beta ? ICONS[kind].color : "text-muted-foreground";
  return (
    <Icon
      data-icon-kind={kind}
      className={cn("size-4 shrink-0", color, className)}
      aria-hidden="true"
      {...(strokeWidth === undefined ? {} : { strokeWidth })}
    />
  );
}
