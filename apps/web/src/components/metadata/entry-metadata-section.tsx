"use client";

import type { FsEntry } from "@fdrive/contracts";
import { useState } from "react";
import { Separator } from "@/components/ui/separator";
import type { TagColor } from "@/lib/metadata/colors";
import { tagDotClassName } from "@/lib/metadata/colors";
import {
  useSetFileTags,
  useTagMutations,
  useTags,
  useToggleFavorite,
} from "@/lib/metadata/queries";
import { tagCheckState, toggleTagId } from "@/lib/metadata/tag-set";
import { cn } from "@/lib/utils";
import { FavoriteToggleRow } from "./favorite-toggle-row";
import { TagPickerPopover } from "./tag-picker-popover";

export interface EntryMetadataSectionProps {
  readonly entries: readonly FsEntry[];
}

function entryFavorite(entry: FsEntry): boolean {
  return entry.meta?.favorite === true;
}

/**
 * The Inspector's "Tags" and "Favorite" sections, shared by the single- and
 * multi-selection bodies: a row of the selection's current tags, an "Add
 * tag" popover (`TagPicker`) that also creates new tags inline, and a
 * favorite star toggle. Every mutation applies to every entry in
 * `entries`, so a multi-selection tags or favorites them all at once.
 */
export function EntryMetadataSection({ entries }: EntryMetadataSectionProps) {
  const tagsQuery = useTags();
  const tags = tagsQuery.data ?? [];
  const setFileTags = useSetFileTags();
  const toggleFavorite = useToggleFavorite();
  const { createTag } = useTagMutations();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (entries.length === 0) {
    return null;
  }

  const metaEntries = entries.map((entry) => ({
    path: entry.path,
    tagIds: entry.meta?.tagIds ?? [],
  }));
  const allFavorite = entries.every(entryFavorite);
  const presentTagIds = [...new Set(metaEntries.flatMap((item) => item.tagIds))];

  function handleToggleTag(tagId: string, checked: boolean) {
    setFileTags.mutate(
      metaEntries.map((item) => ({
        path: item.path,
        tagIds: toggleTagId(item.tagIds, tagId, checked),
      })),
    );
  }

  function handleCreateTag(name: string, color: TagColor) {
    createTag.mutate(
      { name, color: color === "none" ? null : color },
      {
        onSuccess: (tag) => {
          setFileTags.mutate(
            metaEntries.map((item) => ({ path: item.path, tagIds: [...item.tagIds, tag.id] })),
          );
          setPickerOpen(false);
        },
      },
    );
  }

  function handleToggleFavorite(next: boolean) {
    for (const entry of entries) {
      toggleFavorite.mutate({ path: entry.path, favorite: next });
    }
  }

  return (
    // No horizontal padding of its own: the caller supplies the same inset as the
    // details list above, so the separators here span the same width.
    <div className="flex flex-col gap-3 pt-1">
      <Separator />
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Tags</span>
        <TagPickerPopover
          tags={tags}
          checkState={(tagId) => tagCheckState(metaEntries, tagId)}
          onToggle={handleToggleTag}
          onCreate={handleCreateTag}
          creating={createTag.isPending}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      </div>
      {presentTagIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presentTagIds.map((tagId) => {
            const tag = tags.find((candidate) => candidate.id === tagId);
            if (tag === undefined) {
              return null;
            }
            return (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
              >
                <span className={cn("size-1.5 rounded-full", tagDotClassName(tag.color))} />
                {tag.name}
              </span>
            );
          })}
        </div>
      )}
      <Separator />
      <FavoriteToggleRow favorite={allFavorite} onToggle={handleToggleFavorite} />
    </div>
  );
}
