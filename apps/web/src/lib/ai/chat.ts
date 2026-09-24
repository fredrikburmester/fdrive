import type { Chat, ChatActionProposal, ChatPart, ChatState } from "@fdrive/contracts";
import { baseName, extensionOf, joinPath, parentPath } from "@fdrive/core";
import { pathFromFilesPathname, pathToHref } from "@/lib/files/path-url";
import { parseSelectParam, revealTarget } from "@/lib/files/reveal";

/** Starter prompts for an empty chat. */
export const CHAT_SUGGESTIONS = [
  "What are these files about?",
  "Is this a duplicate of another file?",
  "Can I remove these files?",
  "Where should these go?",
] as const;

/** Where a cited path leads: the folder itself, or the parent folder with the file selected. */
export function hrefForPath(path: string, kind: "file" | "dir" | "unknown" = "unknown"): string {
  const name = baseName(path);
  const looksLikeFile = kind === "file" || (kind === "unknown" && extensionOf(name) !== "");
  return looksLikeFile && path !== "/"
    ? revealTarget(pathToHref(parentPath(path)), name)
    : pathToHref(path);
}

/** The path a browse link leads to, the selected item included; `null` for any other link. */
export function pathForHref(href: string): string | null {
  const url = new URL(href, "http://fdrive.invalid");
  const folder = pathFromFilesPathname(url.pathname);
  if (folder === null) return null;
  const selected = parseSelectParam(url.search);
  return selected === null ? folder : joinPath(folder, selected);
}

const PATH_PATTERN = /(^|[\s(["'`])(\/[^\s)"'`<>*]+?)(?=[.,;:!?)\]"'`*]*(?:\s|$))/g;

/** A code span holding nothing but one absolute path; its backticks bound the path, so it may contain spaces. */
const CODE_PATH_PATTERN = /^` ?(\/(?!\/)[^`\n*]*?)(\/?) ?`$/;

/** A markdown link destination: parentheses are escaped so a name like "Report (final).pdf" cannot end it early. */
function linkTarget(path: string, kind: "dir" | "unknown" = "unknown"): string {
  return hrefForPath(path, kind).replaceAll("(", "%28").replaceAll(")", "%29");
}

/**
 * Turns the absolute paths in an assistant's markdown into links to the
 * file browser. A code span holding just a path always becomes a link,
 * since the model writes drive paths that way. A bare path in prose has
 * no clear end, so it is linked only when the chat knows it (references,
 * cards, tool results). Fenced blocks and existing links are left alone.
 */
export function linkifyPaths(markdown: string, known: ReadonlySet<string>): string {
  // Protect code spans, fenced blocks and existing links from the prose rewrite.
  const protectedSpans = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\))/g;
  return markdown
    .split(protectedSpans)
    .map((segment, index) => {
      if (index % 2 === 1) {
        const match = CODE_PATH_PATTERN.exec(segment);
        if (match === null) return segment;
        const [, path = "/", slash] = match;
        return `[${segment}](${linkTarget(path, slash === "" ? "unknown" : "dir")})`;
      }
      if (known.size === 0) return segment;
      return segment.replace(PATH_PATTERN, (match, lead: string, path: string) =>
        known.has(path) ? `${lead}[${path}](${linkTarget(path)})` : match,
      );
    })
    .join("");
}

/** Every path a chat has talked about: references, attached items, card items and tool results. */
export function knownPaths(chat: Pick<Chat, "references" | "messages">): Set<string> {
  const paths = new Set<string>();
  for (const reference of chat.references) paths.add(reference.path);
  for (const message of chat.messages) {
    for (const path of message.references) paths.add(path);
    for (const part of message.parts) {
      if (part.kind === "action") for (const path of proposalPaths(part.proposal)) paths.add(path);
      else if (part.kind === "tool") {
        for (const match of part.output.matchAll(/(?:^|\s)(\/[^\s:,;)]+)/g)) {
          const path = match[1] as string;
          paths.add(path.replace(/[.,;:!?]+$/, ""));
        }
      }
    }
  }
  return paths;
}

export function proposalPaths(proposal: ChatActionProposal): string[] {
  switch (proposal.kind) {
    case "move":
      return proposal.suggestions.flatMap((item) => [item.path, item.destination, item.target]);
    case "trash":
      return proposal.items.map((item) => item.path);
    case "write":
      return [proposal.path];
  }
}

/** What the chat is doing, for the panel header and the activity pill. */
export function chatStatusLabel(state: ChatState): string | null {
  switch (state) {
    case "running":
      return "Answering…";
    case "awaiting_approval":
      return "Waiting for you";
    case "closed":
      return "This chat is full";
    default:
      return null;
  }
}

/** The apply button's label for a card. */
export function applyLabel(proposal: ChatActionProposal, count: number): string {
  switch (proposal.kind) {
    case "move":
      return `Move ${itemCount(count)}`;
    case "trash":
      return `Trash ${itemCount(count)}`;
    case "write":
      return proposal.mode === "create" ? "Create file" : "Replace file";
  }
}

export function itemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** A pending card in the last assistant message, if any. */
export function pendingActions(chat: Pick<Chat, "messages">): (ChatPart & { kind: "action" })[] {
  const last = chat.messages.at(-1);
  if (last?.role !== "assistant") return [];
  return last.parts.filter(
    (part): part is ChatPart & { kind: "action" } =>
      part.kind === "action" && part.state === "pending",
  );
}

/** The text the person typed, from a user message's parts. */
export function userText(parts: readonly ChatPart[]): string {
  return parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}

/** How a reply that is still being written should look: true while the last message is an empty assistant turn. */
export function isThinking(chat: Pick<Chat, "state" | "messages">): boolean {
  if (chat.state !== "running") return false;
  const last = chat.messages.at(-1);
  return last?.role === "assistant" && last.parts.length === 0;
}
