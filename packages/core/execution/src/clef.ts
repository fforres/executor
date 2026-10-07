import * as Data from "effect/Data";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Clef — Cloudflare's relevance classifier on Workers AI, not a chat model.
//
// One call answers many small questions about one shared `state` and returns a
// probability per question, which is what makes it cheap enough to score a tool
// catalog: the questions are nearly free, the extra PASSES are what cost, so a
// shard of up to 64 tools is one call.
//
// Reached through the Workers AI binding (`env.AI.run(model, body, { gateway })`),
// never the AI Gateway's OpenAI-compatible path, which drops the `answers`.
// ---------------------------------------------------------------------------

export const CLEF_FLASH_MODEL = "@cf/cloudflare/clef-flash";
export const CLEF_MODEL = "@cf/cloudflare/clef";

/** Clef accepts at most this many questions per request. */
export const CLEF_MAX_QUESTIONS = 64;

export class ClefError extends Data.TaggedError("ClefError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The slice of the Workers AI binding Clef needs. */
export interface ClefAiBinding {
  readonly run: (
    model: string,
    inputs: unknown,
    options?: { readonly gateway?: { readonly id: string } },
  ) => Promise<unknown>;
}

export interface ClefConfig {
  readonly ai: ClefAiBinding;
  /** Defaults to {@link CLEF_FLASH_MODEL}. */
  readonly model?: string;
  /** AI Gateway id the call is logged through. Omitted: no gateway. */
  readonly gatewayId?: string;
}

export interface ClefQuestion {
  readonly id: string;
  readonly instructions: string;
}

export interface ClefAnswer {
  readonly id: string;
  /** Probability in [0, 1] that the question holds for the state. */
  readonly probability: number;
}

export interface AskClefOptions {
  readonly config: ClefConfig;
  /** The shared context every question is asked against. */
  readonly state: string;
  readonly questions: readonly ClefQuestion[];
}

const readAnswers = (body: unknown): readonly ClefAnswer[] | null => {
  if (typeof body !== "object" || body === null || !("answers" in body)) return null;
  const answers = (body as { readonly answers: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return null;
  return Object.entries(answers).flatMap(([id, answer]) => {
    const noul =
      typeof answer === "object" && answer !== null && "noul" in answer
        ? (answer as { readonly noul: unknown }).noul
        : undefined;
    return typeof noul === "number" && Number.isFinite(noul) ? [{ id, probability: noul }] : [];
  });
};

/**
 * Score every question against one state. A question Clef declines to score is
 * absent from the result rather than zero, so a caller can tell "not relevant"
 * from "no opinion". Fails with {@link ClefError} when the binding throws or the
 * response carries no `answers`.
 */
export const askClef = (options: AskClefOptions): Effect.Effect<readonly ClefAnswer[], ClefError> =>
  Effect.gen(function* () {
    if (options.questions.length === 0) return [];
    if (options.questions.length > CLEF_MAX_QUESTIONS) {
      return yield* new ClefError({
        message: `Clef accepts at most ${CLEF_MAX_QUESTIONS} questions per request, got ${options.questions.length}`,
      });
    }
    const ids = new Set(options.questions.map((question) => question.id));
    if (ids.size !== options.questions.length) {
      // The body keys questions by id, so a duplicate would silently drop one
      // question and misattribute its answer to the other.
      return yield* new ClefError({ message: "Duplicate Clef question id" });
    }

    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    for (const question of options.questions) {
      questions[question.id] = { type: "noul", instructions: question.instructions };
    }

    const { ai, model = CLEF_FLASH_MODEL, gatewayId } = options.config;
    const body = yield* Effect.tryPromise({
      try: () =>
        ai.run(
          model,
          { state: options.state, questions },
          gatewayId === undefined ? undefined : { gateway: { id: gatewayId } },
        ),
      catch: (cause) => new ClefError({ message: "Clef request failed", cause }),
    });
    const answers = readAnswers(body);
    if (answers === null) {
      return yield* new ClefError({ message: "Clef response carried no answers" });
    }
    return answers;
  });
