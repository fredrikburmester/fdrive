import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { E2E_HOST } from "./paths.js";

export const FAKE_AI_MODEL = "fake-organizer";

interface ChatMessage {
  readonly role: string;
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: { function: { name: string; arguments: string } }[];
}

export interface FakeAi {
  readonly baseUrl: string;
  /** Every `/chat/completions` body received, oldest first. */
  readonly requests: readonly {
    messages: ChatMessage[];
    tools?: { function: { name: string } }[];
  }[];
  stop(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function textReply(content: string) {
  return { choices: [{ finish_reason: "stop", message: { content } }] };
}

/** The attached paths in the latest person message, as the chat lists them. */
function attachedPaths(messages: readonly ChatMessage[]): string[] {
  const latest = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  return [...latest.matchAll(/^- (\/.+?) \(/gm)].map((match) => match[1] as string);
}

/**
 * The chat script: reads the first attached file when asked what files are
 * about and answers with paths in prose and in code (one written with a
 * single-character "Å"), proposes a move into a `Notes` folder next to the file, drafts a
 * professional version as a new text file, and answers a duplicate
 * question in words. After a tool result it confirms in one line.
 */
function chatReply(messages: readonly ChatMessage[]) {
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const call = [...messages].reverse().find((message) => message.tool_calls?.length)
      ?.tool_calls?.[0];
    const name = call?.function.name ?? "";
    const paths = attachedPaths(messages);
    if (name === "read_file") {
      const first = paths[0] ?? "/";
      return textReply(
        `${first} is an invoice for 2024; \`${paths[1] ?? "/"}\` is a shopping list. Tax papers go in \`${first.slice(0, first.lastIndexOf("/"))}/Årsbesked\`.`,
      );
    }
    if (name === "move_items") return textReply("Moved them into Notes.");
    if (name === "write_text_file") return textReply("Saved the professional version next to it.");
    return textReply("Done.");
  }
  const question = (last?.content ?? "").toLowerCase();
  const paths = attachedPaths(messages);
  const first = paths[0] ?? "/";
  const folder = first.slice(0, first.lastIndexOf("/"));
  if (question.includes("about")) return toolCall("call-read", "read_file", { path: first });
  if (question.includes("duplicate"))
    return textReply(
      "I cannot compare contents here: the file is not indexed, so I can only go by names.",
    );
  if (question.includes("move"))
    return toolCall("call-move", "move_items", {
      summary: "Notes go into a Notes folder.",
      moves: paths.map((path) => ({
        path,
        destination: `${folder}/Notes`,
        reason: "It is a note.",
      })),
    });
  if (question.includes("rewrite"))
    return toolCall("call-write", "write_text_file", {
      summary: "A more professional version, as a new file.",
      path: `${folder}/shopping-professional.txt`,
      mode: "create",
      text: "Grocery list\n\n- Milk\n- Eggs",
    });
  return textReply("Hello. Attach files to ask about them.");
}

function toolCall(id: string, name: string, args: unknown) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

/**
 * A scripted OpenAI-compatible server for `organize.spec.ts` and `chat.spec.ts`
 * (the chat script is `chatReply`). For Organize it first asks
 * for the folder tree, then files every selected item whose name contains
 * "invoice" under the sandbox's existing `Finance` folder and everything else
 * under a new `Notes` folder. It runs in the Playwright worker, which the
 * host-run e2e API reaches on the loopback address.
 */
export async function startFakeAi(): Promise<FakeAi> {
  const requests: FakeAi["requests"][number][] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: FAKE_AI_MODEL }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      const body = (await readJson(req)) as FakeAi["requests"][number];
      requests.push(body);
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.startsWith("You are the assistant inside fdrive")) {
        res.end(JSON.stringify(chatReply(body.messages)));
        return;
      }
      if (!body.messages.some((message) => message.role === "tool")) {
        res.end(JSON.stringify(toolCall("call-tree", "folder_tree", { path: "/", depth: 1 })));
        return;
      }
      const selection = body.messages.find((message) => message.role === "user")?.content ?? "";
      const paths = [...selection.matchAll(/^- (\/.+) \(/gm)].map((match) => match[1] as string);
      const moves = paths.map((path) => {
        const sandbox = path.split("/").slice(0, -2).join("/");
        const invoice = path.includes("invoice");
        return {
          path,
          destination: `${sandbox}/${invoice ? "Finance" : "Notes"}`,
          reason: invoice
            ? "An invoice belongs with the finances."
            : "Loose notes get their own folder.",
        };
      });
      res.end(
        JSON.stringify(
          toolCall("call-submit", "submit_suggestions", {
            summary: "Invoices go to Finance and notes to a new Notes folder.",
            moves,
            unchanged: [],
          }),
        ),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, E2E_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://${E2E_HOST}:${port}/v1`,
    requests,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
