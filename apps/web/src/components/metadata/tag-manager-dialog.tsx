"use client";

import type { Tag } from "@fdrive/contracts";
import { Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { normalizeTagColor, type TagColor } from "@/lib/metadata/colors";
import { useTagFiles, useTagMutations, useTags } from "@/lib/metadata/queries";
import { TagColorSwatches } from "./tag-color-swatches";

export interface TagManagerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

interface TagRowProps {
  readonly tag: Tag;
  readonly onRename: (name: string) => void;
  readonly onRecolor: (color: TagColor) => void;
  readonly onDelete: () => void;
}

function TagRow({ tag, onRename, onRecolor, onDelete }: TagRowProps) {
  const [name, setName] = useState(tag.name);

  useEffect(() => {
    setName(tag.name);
  }, [tag.name]);

  function commitName() {
    const trimmed = name.trim();
    if (trimmed.length > 0 && trimmed !== tag.name) {
      onRename(trimmed);
    } else {
      setName(tag.name);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          aria-label={`Rename ${tag.name}`}
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <TagColorSwatches value={normalizeTagColor(tag.color)} onChange={onRecolor} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${tag.name}`}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * "Manage tags…" from the sidebar's Tags section: a table of every tag with
 * inline rename and recolor, and delete with a confirmation naming how many
 * files currently carry that tag.
 */
export function TagManagerDialog({ open, onOpenChange }: TagManagerDialogProps) {
  const { data: tags } = useTags();
  const { updateTag, deleteTag } = useTagMutations();
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const filesQuery = useTagFiles(deleteTarget?.id ?? null);
  const fileCount = filesQuery.data?.length;

  function handleConfirmDelete() {
    if (deleteTarget === null) {
      return;
    }
    deleteTag.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage tags</DialogTitle>
            <DialogDescription>Rename, recolor, or delete a tag.</DialogDescription>
          </DialogHeader>
          {tags === undefined || tags.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No tags yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead className="text-right">Delete</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tags.map((tag) => (
                  <TagRow
                    key={tag.id}
                    tag={tag}
                    onRename={(name) => updateTag.mutate({ id: tag.id, patch: { name } })}
                    onRecolor={(color) =>
                      updateTag.mutate({
                        id: tag.id,
                        patch: { color: color === "none" ? null : color },
                      })
                    }
                    onDelete={() => setDeleteTarget(tag)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteTarget?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              {fileCount === undefined
                ? "Checking how many files use this tag…"
                : `${fileCount} file${fileCount === 1 ? "" : "s"} will lose this tag.`}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteTag.isPending}
              onClick={handleConfirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
