import { describe, expect, it } from "vitest";
import { wrap } from "./tools.js";

describe("wrap", () => {
  it("returns a text content block with the successful result serialized as JSON", async () => {
    const handler = wrap(async (args: { name: string }) => ({ greeting: `hello ${args.name}` }));

    const result = await handler({ name: "alice" });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ greeting: "hello alice" }) }],
    });
  });

  it("maps a thrown Error to an isError tool result with its message", async () => {
    const handler = wrap(async () => {
      throw new Error("something went wrong");
    });

    const result = await handler({});

    expect(result).toEqual({
      content: [{ type: "text", text: "something went wrong" }],
      isError: true,
    });
  });

  it("maps a thrown non-Error value to an isError tool result via String()", async () => {
    const handler = wrap(async () => {
      throw "plain string failure";
    });

    const result = await handler({});

    expect(result).toEqual({
      content: [{ type: "text", text: "plain string failure" }],
      isError: true,
    });
  });
});
