import { describe, expect, it, vi } from "vitest";
import { AiProviderError } from "./model.ts";
import { createTypeSafeClient, TYPESAFE_ENDPOINT, TYPESAFE_MODEL } from "./typesafe.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch) {
  return createTypeSafeClient({ apiKey: "ts-secret", fetch: fetchImpl });
}

const ASK = {
  state: { note: "hello" },
  questions: { a: { type: "noul", instructions: "Is `note` a greeting?" } },
} as const;

describe("createTypeSafeClient", () => {
  it("posts the state, questions and model with the key, refusing redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ answers: { a: { type: "noul", noul: 0.9 } } }),
    );

    const answers = await client(fetchImpl).systemOne(ASK, AbortSignal.timeout(1000));

    expect(answers).toEqual({ a: { type: "noul", noul: 0.9 } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(TYPESAFE_ENDPOINT);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ts-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: TYPESAFE_MODEL,
      state: { note: "hello" },
      questions: { a: { type: "noul", instructions: "Is `note` a greeting?" } },
    });
  });

  it("reads a Score answer's levels and confidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        answers: {
          a: { type: "score", score: 1.4, confidence: 0.35, probabilities: { "0": 0.6, "1": 0.4 } },
        },
      }),
    );

    const answers = await client(fetchImpl).systemOne(ASK, AbortSignal.timeout(1000));

    expect(answers.a).toEqual({
      type: "score",
      score: 1.4,
      confidence: 0.35,
      probabilities: { "0": 0.6, "1": 0.4 },
    });
  });

  it.each([
    [401, "TypeSafe rejected the API key."],
    [403, "TypeSafe rejected the API key."],
    [429, "TypeSafe is rate limiting fdrive."],
  ])("turns %i into a message that never repeats the key", async (status, message) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status }));

    const error = await client(fetchImpl)
      .systemOne(ASK, AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).message).toBe(message);
  });

  it("includes a short detail from any other error status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("too many questions", { status: 422 }),
    );

    const error = await client(fetchImpl)
      .systemOne(ASK, AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);

    expect((error as AiProviderError).message).toBe(
      "TypeSafe returned an error (422): too many questions",
    );
  });

  it("reports an unreachable service rather than the underlying failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND api.typesafe.ai");
    });

    const error = await client(fetchImpl)
      .systemOne(ASK, AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);

    expect((error as AiProviderError).message).toBe("Could not reach TypeSafe.");
  });

  it("propagates the caller's abort instead of reporting a failure", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error("cancelled"));
      throw new Error("aborted");
    });

    const error = await client(fetchImpl)
      .systemOne(ASK, controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(AiProviderError);
  });

  it("refuses an answer shape it does not understand", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ answers: { a: { type: "vibes", vibe: "good" } } }),
    );

    const error = await client(fetchImpl)
      .systemOne(ASK, AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);

    expect((error as AiProviderError).message).toBe(
      "TypeSafe sent a response fdrive does not understand.",
    );
  });

  it("reports a body that is not JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));

    const error = await client(fetchImpl)
      .systemOne(ASK, AbortSignal.timeout(1000))
      .catch((caught: unknown) => caught);

    expect((error as AiProviderError).message).toBe("TypeSafe sent a response that is not JSON.");
  });

  describe("ping", () => {
    it("asks one throwaway question and reports success", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ answers: { ok: { type: "noul", noul: 1 } } }),
      );

      const result = await client(fetchImpl).ping(AbortSignal.timeout(1000));

      expect(result.ok).toBe(true);
      expect(result.message).toContain(TYPESAFE_MODEL);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a rejected key as a failed check rather than throwing", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 401 }));

      expect(await client(fetchImpl).ping(AbortSignal.timeout(1000))).toEqual({
        ok: false,
        message: "TypeSafe rejected the API key.",
      });
    });
  });
});
