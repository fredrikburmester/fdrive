"use client";

import type { Tag } from "@fdrive/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { TagColor } from "@/lib/metadata/colors";
import { tagDotClassName } from "@/lib/metadata/colors";
import { filterTags, hasNoExactMatch } from "@/lib/metadata/filter-tags";
import type { TagCheckState } from "@/lib/metadata/tag-set";
import { cn } from "@/lib/utils";
import { TagColorSwatches } from "./tag-color-swatches";

export interface TagPickerContentProps {
  readonly tags: readonly Tag[];
  readonly checkState: (tagId: string) => TagCheckState;
  readonly onToggle: (tagId: string, checked: boolean) => void;
  readonly onCreate: (name: string, color: TagColor) => void;
  readonly creating?: boolean | undefined;
}

/**
 * The picker's list: a searchable, checkable list of every tag (checkbox
 * shows indeterminate for a mixed multi-selection), and, once nothing
 * matches the search exactly, a "Create tag '<name>'" option that expands
 * into an inline name + color form. Shared by the Inspector's popover and
 * the row context menu's "Edit tags" dialog.
 */
export function TagPickerContent({
  tags,
  checkState,
  onToggle,
  onCreate,
  creating = false,
}: TagPickerContentProps) {
  const [query, setQuery] = useState("");
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [newColor, setNewColor] = useState<TagColor>("blue");

  const filtered = filterTags(tags, query);
  const trimmedQuery = query.trim();
  const offerCreate = hasNoExactMatch(tags, query);

  function startCreate() {
    setCreatingName(trimmedQuery);
  }

  function submitCreate() {
    if (creatingName === null || creatingName.length === 0) {
      return;
    }
    onCreate(creatingName, newColor);
    setCreatingName(null);
    setNewColor("blue");
    setQuery("");
  }

  if (creatingName !== null) {
    return (
      <div className="flex flex-col gap-3 p-1">
        <Field>
          <FieldLabel htmlFor="tag-picker-new-name">Name</FieldLabel>
          <Input
            id="tag-picker-new-name"
            value={creatingName}
            onChange={(event) => setCreatingName(event.target.value)}
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel>Color</FieldLabel>
          <TagColorSwatches value={newColor} onChange={setNewColor} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreatingName(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={creatingName.trim().length === 0 || creating}
            onClick={submitCreate}
          >
            Create
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Command shouldFilter={false} className="rounded-lg!">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Find or create a tag" />
      <CommandList>
        <CommandEmpty>
          {offerCreate ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={startCreate}
            >
              <PlusIcon className="size-4" />
              Create tag &quot;{trimmedQuery}&quot;
            </button>
          ) : (
            "No tags yet"
          )}
        </CommandEmpty>
        {filtered.length > 0 && (
          <CommandGroup>
            {filtered.map((tag) => {
              const state = checkState(tag.id);
              return (
                <CommandItem
                  key={tag.id}
                  value={tag.id}
                  onSelect={() => onToggle(tag.id, state !== "checked")}
                >
                  <Checkbox
                    checked={state === "checked"}
                    indeterminate={state === "indeterminate"}
                    className="pointer-events-none"
                    tabIndex={-1}
                  />
                  <span
                    className={cn("size-2 shrink-0 rounded-full", tagDotClassName(tag.color))}
                  />
                  <span className="truncate">{tag.name}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {offerCreate && filtered.length > 0 && (
          <div className="border-t p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={startCreate}
            >
              <PlusIcon className="size-4" />
              Create tag &quot;{trimmedQuery}&quot;
            </button>
          </div>
        )}
      </CommandList>
    </Command>
  );
}
