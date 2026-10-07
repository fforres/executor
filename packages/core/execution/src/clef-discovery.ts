import { Effect } from "effect";

import { askClef, CLEF_MAX_QUESTIONS, type ClefConfig } from "./clef";
import {
  defaultToolDiscoveryProvider,
  matchesNamespace,
  paginate,
  scoreToolMatch,
  toSearchableTool,
  type SearchableTool,
  type ToolDiscoveryInput,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "./tool-invoker";

// ---------------------------------------------------------------------------
// Semantic ranking for tool search with Clef.
//
// Clef IS the ranker; lexical matching is the fallback, per shard and wholesale.
// The catalog is split into shards of at most CLEF_MAX_QUESTIONS tools (the
// request limit), each scored in one call, a few at a time, and the answers are
// merged into one ranking. A shard that fails contributes its lexical matches
// instead of losing the rest, and the result says it was not fully ranked.
// ---------------------------------------------------------------------------

/** Below this probability Clef's opinion is too weak to show as a match. */
export const CLEF_MIN_PROBABILITY = 0.3;

/** A tool's description is truncated to this before scoring: a verbose one
 *  would otherwise dominate the state, and the opening carries the meaning. */
export const CLEF_MAX_DESCRIPTION_CHARS = 300;

/** Shards scored at once: enough to cover a large catalog in one round trip
 *  without an unbounded number of calls from a Worker. */
export const CLEF_SHARD_CONCURRENCY = 4;

/** How long a ranking is served again for the same (subject, scope, query). */
export const CLEF_CACHE_TTL_MS = 60_000;

const CLEF_CACHE_MAX_ENTRIES = 256;

/** Lexical hits never outrank a Clef answer: they are scored below the cutoff. */
const LEXICAL_FALLBACK_CEILING = Math.round(CLEF_MIN_PROBABILITY * 100) - 1;

interface CachedRanking {
  readonly expiresAt: number;
  readonly ranked: boolean;
  readonly results: readonly ToolDiscoveryResult[];
}

/** Short-lived in-memory ranking cache. One instance per isolate is plenty. */
export interface ClefRankingCache {
  readonly get: (key: string) => CachedRanking | undefined;
  readonly set: (key: string, value: CachedRanking) => void;
}

export const makeClefRankingCache = (now: () => number = Date.now): ClefRankingCache => {
  const entries = new Map<string, CachedRanking>();
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > CLEF_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
};

export interface ClefToolDiscoveryOptions {
  /** Absent: Clef is unavailable and search stays lexical, flagged `ranked: false`. */
  readonly clef?: ClefConfig;
  /** Whose catalog is ranked; part of the cache key. */
  readonly subject: string;
  readonly cache?: ClefRankingCache;
  readonly now?: () => number;
  /** The lexical provider used as the fallback. Defaults to the built-in one. */
  readonly delegate?: ToolDiscoveryProvider;
}

export const clefToolDescription = (tool: SearchableTool): string =>
  tool.description === undefined || tool.description.trim().length === 0
    ? tool.path
    : `${tool.path}: ${tool.description.slice(0, CLEF_MAX_DESCRIPTION_CHARS)}`;

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

const toResult = (tool: SearchableTool, score: number): ToolDiscoveryResult => ({
  path: tool.path,
  name: tool.name,
  integration: tool.integration,
  score,
  ...(tool.description === undefined ? {} : { description: tool.description }),
});

const byScore = (left: ToolDiscoveryResult, right: ToolDiscoveryResult): number =>
  right.score - left.score || left.path.localeCompare(right.path);

export const makeClefToolDiscoveryProvider = (
  options: ClefToolDiscoveryOptions,
): ToolDiscoveryProvider => {
  const delegate = options.delegate ?? defaultToolDiscoveryProvider;
  const now = options.now ?? Date.now;

  return {
    searchTools: (input: ToolDiscoveryInput) =>
      Effect.gen(function* () {
        const query = input.query.trim();
        const clef = options.clef;
        // An empty query is enumeration, not search: there is nothing to be
        // semantically closer to.
        if (query.length === 0) return yield* delegate.searchTools(input);
        if (clef === undefined) {
          yield* Effect.annotateCurrentSpan({ "executor.search.clef.attempted": false });
          return { ...(yield* delegate.searchTools(input)), ranked: false };
        }

        const namespace = input.namespace?.trim() ?? "";
        const cacheKey = [options.subject, input.scope ?? "", namespace, query].join("\u0000");
        const cached = options.cache?.get(cacheKey);
        if (cached !== undefined) {
          yield* Effect.annotateCurrentSpan({ "executor.search.clef.cache_hit": true });
          return {
            ...paginate(cached.results, input.offset, input.limit),
            ranked: cached.ranked,
          };
        }

        const all = yield* input.executor.tools
          .list({ includeAnnotations: false })
          .pipe(Effect.orElseSucceed(() => []));
        const candidates = all
          .map(toSearchableTool)
          .filter((tool) => matchesNamespace(tool, namespace));
        if (candidates.length === 0) {
          return { ...paginate([], input.offset, input.limit), ranked: true };
        }

        const shards = chunk(candidates, CLEF_MAX_QUESTIONS);
        const scoreShard = (tools: readonly SearchableTool[]) =>
          askClef({
            config: clef,
            state: [
              `Request: ${query}`,
              "",
              "Each question asks whether one of these tools helps with the request.",
              "Tools:",
              ...tools.map(clefToolDescription),
            ].join("\n"),
            questions: tools.map((tool) => ({
              id: tool.path,
              instructions: `Is the tool ${tool.path} useful for the request?`,
            })),
          }).pipe(
            Effect.map((answers) => {
              const byPath = new Map(tools.map((tool) => [tool.path, tool]));
              return {
                failed: false,
                results: answers.flatMap((answer) => {
                  const tool = byPath.get(answer.id);
                  return tool === undefined || answer.probability < CLEF_MIN_PROBABILITY
                    ? []
                    : [toResult(tool, Math.round(answer.probability * 100))];
                }),
              };
            }),
            // One failed shard must not lose the others: it falls back to the
            // lexical matches over its own tools.
            Effect.catch(() =>
              Effect.succeed({
                failed: true,
                results: tools.flatMap((tool) => {
                  const match = scoreToolMatch(tool, query);
                  return match === null
                    ? []
                    : [toResult(tool, Math.min(match.score, LEXICAL_FALLBACK_CEILING))];
                }),
              }),
            ),
          );

        const shardOutcomes = yield* Effect.all(shards.map(scoreShard), {
          concurrency: CLEF_SHARD_CONCURRENCY,
        });
        const failedShards = shardOutcomes.filter((outcome) => outcome.failed).length;
        const results = shardOutcomes.flatMap((outcome) => outcome.results).sort(byScore);
        const ranked = failedShards === 0;

        options.cache?.set(cacheKey, { expiresAt: now() + CLEF_CACHE_TTL_MS, ranked, results });
        yield* Effect.annotateCurrentSpan({
          "executor.search.clef.attempted": true,
          "executor.search.clef.candidate_count": candidates.length,
          "executor.search.clef.shard_count": shards.length,
          "executor.search.clef.failed_shards": failedShards,
          "executor.search.clef.ranked_count": results.length,
        });
        return { ...paginate(results, input.offset, input.limit), ranked };
      }),
  };
};
