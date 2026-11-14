import { z } from "zod";
import { AiProviderError } from "./model.ts";

/**
 * TypeSafe's System One API: a state plus typed questions in, one typed
 * answer per question out. Unlike the providers behind `AiModel` it neither
 * generates text nor calls tools, so it is not an `AiProvider`; it answers
 * questions fdrive's own code composes.
 */
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** TypeSafe's flagship model, tracking whichever Jev version is current. */
export const TYPESAFE_MODEL = "jev-latest";

const DEFAULT_TIMEOUT_MS = 60 * 1000;

/** Yes/no. The answer is the probability of yes; there is no separate confidence. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: unknown;
  readonly criteria?: { readonly true?: unknown; readonly false?: unknown };
}

/** A position on an ordered rubric. `criteria` is the levels, lowest first. */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: unknown;
  readonly criteria: readonly unknown[];
}

export type TypeSafeQuestion = NoulQuestion | ScoreQuestion;

const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });

const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  /** The probability of each level, keyed by its number as a string. */
  probabilities: z.record(z.string(), z.number()),
});

const Answer = z.discriminatedUnion("type", [NoulAnswer, ScoreAnswer]);

export type NoulAnswer = z.infer<typeof NoulAnswer>;
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;
export type TypeSafeAnswer = z.infer<typeof Answer>;

const SystemOneResponse = z.object({
  answers: z.record(z.string(), Answer),
});

export interface TypeSafeRequest {
  /** The shared context every question in the request asks about. */
  readonly state: unknown;
  /** Questions by an id of your choosing; answers come back under the same ids. */
  readonly questions: Readonly<Record<string, TypeSafeQuestion>>;
}

export interface TypeSafeClient {
  /** Answers every question in one request; they are evaluated in parallel. */
  systemOne(request: TypeSafeRequest, signal: AbortSignal): Promise<Record<string, TypeSafeAnswer>>;
  /** Checks the key without asking anything useful. */
  ping(signal: AbortSignal): Promise<{ ok: boolean; message: string }>;
}

export interface TypeSafeClientOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/**
 * Talks to TypeSafe over `fetch`. Redirects are refused so the key only ever
 * reaches the configured endpoint, and every failure is an `AiProviderError`
 * whose message is safe to show and never repeats the key.
 */
export function createTypeSafeClient(options: TypeSafeClientOptions): TypeSafeClient {
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(request: TypeSafeRequest, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: TYPESAFE_MODEL,
          state: request.state,
          questions: request.questions,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AiProviderError("Could not reach TypeSafe.");
    }
    if (response.status === 401 || response.status === 403)
      throw new AiProviderError("TypeSafe rejected the API key.");
    if (response.status === 429) throw new AiProviderError("TypeSafe is rate limiting fdrive.");
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new AiProviderError(
        `TypeSafe returned an error (${response.status})${detail ? `: ${detail}` : "."}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AiProviderError("TypeSafe sent a response that is not JSON.");
    }
  }

  return {
    async systemOne(request, signal) {
      const parsed = SystemOneResponse.safeParse(await post(request, signal));
      if (!parsed.success)
        throw new AiProviderError("TypeSafe sent a response fdrive does not understand.");
      return parsed.data.answers;
    },

    async ping(signal) {
      try {
        await this.systemOne(
          {
            state: { check: "fdrive connection check" },
            questions: { ok: { type: "noul", instructions: "Is `check` a sentence?" } },
          },
          signal,
        );
        return { ok: true, message: `Connected to TypeSafe. ${TYPESAFE_MODEL} answered.` };
      } catch (error) {
        if (error instanceof AiProviderError) return { ok: false, message: error.message };
        throw error;
      }
    },
  };
}
