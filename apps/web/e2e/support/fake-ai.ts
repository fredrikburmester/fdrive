import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { E2E_HOST } from "./paths.js";

export const FAKE_AI_MODEL = "fake-organizer";

interface ChatMessage {
  readonly role: string;
  readonly content?: string | null;
  readonly tool_call_id?: string;
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
 * A scripted OpenAI-compatible server for `organize.spec.ts`: it first asks
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
