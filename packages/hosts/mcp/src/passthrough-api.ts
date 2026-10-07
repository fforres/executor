import { Validator } from "@cfworker/json-schema";
import { Effect, Predicate, Schema } from "effect";
import type * as Cause from "effect/Cause";
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";

import { reattachDefs } from "@executor-js/sdk/host-internal";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  isToolResult,
  parseToolAddress,
  type ElicitationContext,
  type ElicitationHandler,
  type ElicitationRequest,
  type ElicitationResponse,
  type Executor,
  type ToolAnnotations,
  type ToolSchemaView,
} from "@executor-js/sdk";
import type { ExecutionEngine, PagedResult, ToolDiscoveryProvider } from "@executor-js/execution";

import { passthroughCallCode } from "./passthrough-tools";

// ---------------------------------------------------------------------------
// The passthrough search/invoke core, shared by the MCP `search`/`invoke` tools
// and any other surface (a host's REST routes) that must rank, describe and
// validate tools identically.
// ---------------------------------------------------------------------------

/** The same list and schema APIs used by codemode discovery. */
export type McpToolsPort = Pick<Executor["tools"], "list" | "schema">;

/** Workers-compatible JSON Schema validator (replaces Ajv, which uses `new Function()`). */
export class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validator = new Validator(schema as Record<string, unknown>, "2020-12", false);
    return (input: unknown) => {
      const result = validator.validate(input);
      if (result.valid) {
        return { valid: true, data: input as T, errorMessage: undefined };
      }
      const errorMessage = result.errors.map((e) => `${e.instanceLocation}: ${e.error}`).join("; ");
      return { valid: false, data: undefined, errorMessage };
    };
  }
}

/** Serialize one existing schema view as a self-contained input schema. */
export const passthroughInputSchema = (view: ToolSchemaView): unknown =>
  reattachDefs(
    view.inputSchema ?? { type: "object", properties: {} },
    new Map(Object.entries(view.schemaDefinitions ?? {})),
  );

/** Bounds shared by every surface that exposes passthrough search. */
export const PASSTHROUGH_SEARCH_QUERY_MAX = 500;
export const PASSTHROUGH_SEARCH_LIMIT_DEFAULT = 10;
export const PASSTHROUGH_SEARCH_LIMIT_MAX = 20;

/**
 * The search input as a non-MCP surface (REST, RPC) accepts it. `integrations`
 * is an allow list of exact integration slugs; one ranking runs over the catalog
 * restricted to them. An empty list allows nothing.
 */
export const PassthroughSearchInput = Schema.Struct({
  query: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PASSTHROUGH_SEARCH_QUERY_MAX),
  ),
  integrations: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(200)),
  ),
  integration: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  owner: Schema.optionalKey(Schema.Literals(["org", "user"])),
  connection: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: PASSTHROUGH_SEARCH_LIMIT_MAX }),
    ),
  ),
  offset: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});
export type PassthroughSearchInput = typeof PassthroughSearchInput.Type;

/** The invoke input as a non-MCP surface accepts it. */
export const PassthroughInvokeInput = Schema.Struct({
  tool: Schema.String.check(Schema.isMinLength(1)),
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  approved: Schema.optionalKey(Schema.Boolean),
});
export type PassthroughInvokeInput = typeof PassthroughInvokeInput.Type;

export interface PassthroughSearchParams {
  readonly query: string;
  /** Exact slug of one integration; combined with `integrations` as an intersection. */
  readonly integration?: string | undefined;
  /** Allow list of exact integration slugs. Absent: every integration. */
  readonly integrations?: readonly string[] | undefined;
  readonly owner?: "org" | "user" | undefined;
  readonly connection?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface PassthroughSearchItem {
  readonly id: string;
  readonly name: string;
  readonly integration: string;
  readonly owner: "org" | "user";
  readonly connection: string;
  readonly description: string | undefined;
  readonly inputSchema: unknown;
  readonly annotations?: ToolAnnotations;
}

export type PassthroughSearchResult = PagedResult<PassthroughSearchItem> & {
  /** `false` when the ranker fell back to lexical matching, wholly or in part. */
  readonly ranked?: boolean;
};

/** The integration slugs a search is limited to, sorted and deduplicated; undefined when unrestricted. */
const effectiveIntegrations = (
  params: Pick<PassthroughSearchParams, "integration" | "integrations">,
): readonly string[] | undefined => {
  const { integration, integrations } = params;
  if (integrations === undefined) return integration === undefined ? undefined : [integration];
  const narrowed =
    integration === undefined ? integrations : integrations.filter((slug) => slug === integration);
  return [...new Set(narrowed)].sort();
};

/**
 * Search the visible catalog through the host's discovery provider and attach the
 * input schema and annotations of each match. Static configuration tools are
 * excluded, and a tool that disappears between listing and schema lookup is
 * dropped from the page.
 */
export const searchPassthroughTools = (
  tools: McpToolsPort,
  provider: ToolDiscoveryProvider,
  params: PassthroughSearchParams,
) =>
  Effect.gen(function* () {
    const { query, owner, connection, limit, offset } = params;
    const allowed = effectiveIntegrations(params);
    if (allowed !== undefined && allowed.length === 0) {
      return {
        items: [],
        total: 0,
        hasMore: false,
        nextOffset: null,
        ranked: true,
      } satisfies PassthroughSearchResult;
    }
    // One list call per search. A single allowed integration is pushed into the
    // catalog query itself; several are applied to that one listing in memory.
    const allowedSet = allowed === undefined ? undefined : new Set(allowed);
    const pushedIntegration = allowed?.length === 1 ? allowed[0] : undefined;
    const discovery = {
      tools: {
        list: (filter?: Parameters<McpToolsPort["list"]>[0]) =>
          tools
            .list({
              ...filter,
              ...(pushedIntegration === undefined
                ? {}
                : { integration: IntegrationSlug.make(pushedIntegration) }),
              ...(owner === undefined ? {} : { owner }),
              ...(connection === undefined ? {} : { connection: ConnectionName.make(connection) }),
            })
            .pipe(
              Effect.map((items) =>
                items.filter(
                  (tool) =>
                    tool.static !== true &&
                    (allowedSet === undefined || allowedSet.has(String(tool.integration))),
                ),
              ),
            ),
      },
    };
    // Through the configured provider, not the raw ranker: passthrough search
    // must rank the same way codemode's `tools.search` does.
    const page = yield* provider.searchTools({
      executor: discovery,
      scope: JSON.stringify([owner ?? null, connection ?? null]),
      ...(allowed === undefined ? {} : { integrations: allowed }),
      query,
      limit,
      offset,
    });
    const candidates = yield* Effect.forEach(
      page.items,
      (match) =>
        Effect.gen(function* () {
          const address = ToolAddress.make(`tools.${match.path}`);
          const identity = parseToolAddress(String(address));
          if (!identity) return null;
          const schema = yield* tools.schema(address);
          // Visibility can change between listing and schema lookup.
          if (!schema) return null;
          return {
            id: String(address),
            name: match.name,
            integration: identity.integration,
            owner: identity.owner,
            connection: identity.connection,
            description: match.description,
            inputSchema: passthroughInputSchema(schema),
            ...(schema.annotations ? { annotations: schema.annotations } : {}),
          } satisfies PassthroughSearchItem;
        }),
      { concurrency: 4 },
    );
    return {
      items: candidates.filter(Predicate.isNotNull),
      total: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      ...(page.ranked === undefined ? {} : { ranked: page.ranked }),
    } satisfies PassthroughSearchResult;
  });

export type PassthroughTarget =
  | { readonly status: "ready"; readonly address: ToolAddress; readonly args: unknown }
  | { readonly status: "unavailable" }
  | { readonly status: "invalid_arguments"; readonly message: string };

/**
 * Resolve an invoke request to a callable address: the id must parse, be visible
 * (policy blocks and hidden tools read as unavailable), not be a static
 * configuration tool, and the arguments must satisfy the tool's input schema.
 */
export const resolvePassthroughTarget = (
  tools: McpToolsPort,
  validator: jsonSchemaValidator,
  id: string,
  args: unknown,
) =>
  Effect.gen(function* () {
    const identity = parseToolAddress(id);
    if (!identity) return { status: "unavailable" } satisfies PassthroughTarget;
    const address = ToolAddress.make(id);
    // Use the existing visibility filter and exclude static configuration tools.
    const visible = yield* tools.list({
      integration: identity.integration,
      owner: identity.owner,
      connection: identity.connection,
      query: String(identity.tool),
      includeAnnotations: false,
    });
    if (!visible.some((tool) => tool.static !== true && tool.address === address)) {
      return { status: "unavailable" } satisfies PassthroughTarget;
    }
    const schema = yield* tools.schema(address);
    if (!schema) return { status: "unavailable" } satisfies PassthroughTarget;
    // The validator checks this dynamic JSON schema at the boundary.
    const validate = validator.getValidator<unknown>(
      passthroughInputSchema(schema) as JsonSchemaType,
    );
    const checked = validate(args);
    if (!checked.valid) {
      return {
        status: "invalid_arguments",
        message: `Invalid arguments for tool ${id}: ${checked.errorMessage ?? "invalid"}`,
      } satisfies PassthroughTarget;
    }
    return { status: "ready", address, args: checked.data } satisfies PassthroughTarget;
  });

// ---------------------------------------------------------------------------
// Overview: what the catalog holds, without ranking or loading schemas.
// ---------------------------------------------------------------------------

export interface PassthroughOverviewIntegration {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly toolCount: number;
}

export interface PassthroughOverview {
  readonly integrations: readonly PassthroughOverviewIntegration[];
  /** Tools across the listed integrations. */
  readonly toolCount: number;
}

export type McpIntegrationsCatalogPort = Pick<Executor["integrations"], "list">;

/**
 * Integrations with their visible tool counts, from one integrations listing
 * and one annotation-free tool listing. Executor's own built-in integration and
 * its static configuration tools are left out: they are not something an agent
 * discovers through search.
 */
export const passthroughOverview = (
  integrations: McpIntegrationsCatalogPort,
  tools: Pick<McpToolsPort, "list">,
) =>
  Effect.gen(function* () {
    const [catalog, listed] = yield* Effect.all([
      integrations.list(),
      tools.list({ includeAnnotations: false }),
    ]);
    const counts = new Map<string, number>();
    for (const tool of listed) {
      if (tool.static === true) continue;
      const key = String(tool.integration);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const items = catalog
      .filter((integration) => integration.kind !== "built-in" && integration.slug !== "executor")
      .map((integration): PassthroughOverviewIntegration => {
        const slug = String(integration.slug);
        const sameAsIdentity =
          integration.description.toLowerCase() === slug.toLowerCase() ||
          integration.description.toLowerCase() === integration.name.toLowerCase();
        return {
          slug,
          name: integration.name,
          ...(integration.description.length > 0 && !sameAsIdentity
            ? { description: integration.description }
            : {}),
          toolCount: counts.get(slug) ?? 0,
        };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      integrations: items,
      toolCount: items.reduce((total, item) => total + item.toolCount, 0),
    } satisfies PassthroughOverview;
  });

// ---------------------------------------------------------------------------
// The shared call path: one generated call through the engine, with approval and
// prompt handling, mapped onto a small outcome union that both the MCP `invoke`
// tool and the REST/RPC invoke render.
// ---------------------------------------------------------------------------

type ExecuteOutcome = Effect.Success<ReturnType<ExecutionEngine["execute"]>>;

export interface PassthroughCallInput<E extends Cause.YieldableError> {
  readonly engine: Pick<ExecutionEngine<E>, "execute">;
  readonly address: ToolAddress;
  readonly args: unknown;
  /**
   * Whether the workspace policy's approval prompt is accepted. An MCP client has
   * already approved natively; a REST caller says so with `approved: true`.
   * When false the prompt is declined and the call reports `approval_required`.
   */
  readonly policyApproved: boolean;
  /**
   * Answers a prompt the tool itself raised. Return `undefined` when this
   * surface cannot relay it: the prompt is declined and the call reports
   * `input_required` with what was asked.
   */
  readonly answerToolPrompt?: (
    context: ElicitationContext,
  ) => ReturnType<ElicitationHandler> | undefined;
}

export type PassthroughCallResult =
  | { readonly status: "approval_required"; readonly message: string }
  | { readonly status: "input_required"; readonly request: ElicitationRequest }
  /** The tool returned `ok: true` (or the program returned a non-`ToolResult` value). */
  | { readonly status: "ok"; readonly result: unknown; readonly outcome: ExecuteOutcome }
  /** The workspace policy blocked the tool. */
  | {
      readonly status: "blocked";
      readonly message: string;
      readonly error: { readonly code: string; readonly message: string };
    }
  /** The sandbox failed (`error` is the engine's error) or the tool returned `ok: false`. */
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly logs: readonly string[];
      readonly outcome: ExecuteOutcome;
    };

const declined = Effect.succeed<ElicitationResponse>({ action: "decline" });

export const runPassthroughCall = <E extends Cause.YieldableError>(
  input: PassthroughCallInput<E>,
): Effect.Effect<PassthroughCallResult, E> =>
  Effect.gen(function* () {
    let approval: string | undefined;
    let unanswered: ElicitationRequest | undefined;
    const onElicitation: ElicitationHandler = (ctx) => {
      if (ctx.source === "policy") {
        if (input.policyApproved) {
          return Effect.succeed<ElicitationResponse>({ action: "accept", content: {} });
        }
        approval = ctx.request.message;
        return declined;
      }
      const answer = input.answerToolPrompt?.(ctx);
      if (answer !== undefined) return answer;
      unanswered = ctx.request;
      return declined;
    };

    const outcome = yield* input.engine.execute(passthroughCallCode(input.address, input.args), {
      onElicitation,
    });
    if (approval !== undefined) return { status: "approval_required", message: approval };
    if (unanswered !== undefined) return { status: "input_required", request: unanswered };
    const value = outcome.result;
    const logs = outcome.logs ?? [];
    if (outcome.error) return { status: "error", error: outcome.error, logs, outcome };
    if (!isToolResult(value)) return { status: "ok", result: value, outcome };
    if (value.ok) return { status: "ok", result: value.data, outcome };
    if (value.error.code === "tool_blocked") {
      return { status: "blocked", message: value.error.message, error: value.error };
    }
    return { status: "error", error: value.error, logs, outcome };
  });

// ---------------------------------------------------------------------------
// Bounded results: a tool can return megabytes; a surface that crosses hops
// keeps a bounded text and says how long the original was.
// ---------------------------------------------------------------------------

export const PASSTHROUGH_RESULT_MAX_CHARS = 100_000;

export type BoundedResult =
  | { readonly result: unknown }
  | {
      readonly result: string;
      readonly truncated: true;
      readonly originalLength: number;
    };

/**
 * The value as-is when its JSON form fits `maxChars`; otherwise the first
 * `maxChars` characters of that JSON as a string, flagged `truncated`, with the
 * original JSON length.
 */
export const boundPassthroughResult = (
  value: unknown,
  maxChars: number = PASSTHROUGH_RESULT_MAX_CHARS,
): BoundedResult => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= maxChars) return { result: value };
  return { result: text.slice(0, maxChars), truncated: true, originalLength: text.length };
};
