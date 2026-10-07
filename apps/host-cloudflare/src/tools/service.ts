import { Effect, Layer, Match, Option, Schema } from "effect";

import {
  dbProviderLayer,
  makeExecutionStack,
  makeScopedExecutor,
  RequestWebOrigin,
  type ExecutorDbHandle,
  type Principal,
} from "@executor-js/api/server";
import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";
import {
  boundPassthroughResult,
  CfWorkerJsonSchemaValidator,
  PASSTHROUGH_SEARCH_LIMIT_DEFAULT,
  PassthroughInvokeInput,
  PassthroughSearchInput,
  passthroughOverview,
  resolvePassthroughTarget,
  runPassthroughCall,
  searchPassthroughTools,
  type PassthroughOverview,
  type PassthroughSearchResult,
} from "@executor-js/host-mcp/passthrough-api";
import {
  CurrentOrgWriteAccess,
  makeOrgWriteAccessState,
  type ElicitationRequest,
} from "@executor-js/sdk";

import type { CloudflareConfig } from "../config";
import {
  makeCloudflareExecutionStackLayer,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
  makeCloudflareToolDiscovery,
} from "../execution";
import { preloadQuickJs } from "../quickjs";

// ---------------------------------------------------------------------------
// The tool service behind every non-MCP door (REST `/api/tools/*` and the
// `ExecutorInternal` RPC methods): ranked search, the catalog overview, and
// single-tool invocation. Each door authenticates, then calls these functions
// directly with the acting principal; nothing here knows about HTTP.
//
// MCP clients gate `invoke` natively; a non-MCP caller has no such gate, so a call
// the workspace policy marks as requiring approval does NOT run until the caller
// sends the same request again with `approved: true`. Until then it answers
// `approval_required` with what would run. Blocked tools answer `blocked`.
// ---------------------------------------------------------------------------

export interface InvalidArguments {
  readonly status: "invalid_arguments";
  readonly message: string;
}

/** A search page, or the reason the input was refused. */
export type SearchToolsResult = PassthroughSearchResult | InvalidArguments;

/** `ok` carries `truncated` and `originalLength` when the result was bounded. */
export type InvokeToolResult =
  | {
      readonly status: "ok";
      readonly result: unknown;
      readonly truncated?: true;
      readonly originalLength?: number;
    }
  | { readonly status: "approval_required"; readonly tool: string; readonly message: string }
  | { readonly status: "blocked"; readonly tool: string; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string }
  | InvalidArguments
  | { readonly status: "input_required"; readonly tool: string; readonly message: string }
  | { readonly status: "error"; readonly error: unknown; readonly logs: readonly string[] };

export const INVOKE_HTTP_STATUS: Record<InvokeToolResult["status"], number> = {
  ok: 200,
  approval_required: 202,
  blocked: 403,
  unavailable: 404,
  invalid_arguments: 400,
  input_required: 409,
  error: 502,
};

export interface ToolsService {
  readonly search: (
    principal: Principal,
    input: unknown,
    origin?: string,
  ) => Promise<SearchToolsResult>;
  readonly invoke: (
    principal: Principal,
    input: unknown,
    origin?: string,
  ) => Promise<InvokeToolResult>;
  readonly overview: (principal: Principal, origin?: string) => Promise<PassthroughOverview>;
}

const decodeSearch = Schema.decodeUnknownOption(PassthroughSearchInput);
const decodeInvoke = Schema.decodeUnknownOption(PassthroughInvokeInput);

const requestMessage = (request: ElicitationRequest): string => request.message;

export const makeCloudflareToolsService = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): ToolsService => {
  const validator = new CfWorkerJsonSchemaValidator();
  // Search and overview need the scoped executor and its ranker, nothing else: no
  // QuickJS preload, no engine, no code substrate.
  const executorLayer = Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config),
    makeCloudflareHostConfig(config),
  );
  const stackLayer = makeCloudflareExecutionStackLayer(config, dbHandle);

  const withOrigin = <A, E, R>(effect: Effect.Effect<A, E, R>, origin: string | undefined) =>
    origin === undefined
      ? effect
      : effect.pipe(Effect.provideService(RequestWebOrigin, { origin }));

  const withWriteAccess = <A, E, R>(effect: Effect.Effect<A, E, R>, principal: Principal) =>
    effect.pipe(
      Effect.provideService(
        CurrentOrgWriteAccess,
        makeOrgWriteAccessState(orgWriteAccessForPrincipal(principal)),
      ),
    );

  const withExecutor = <A>(
    principal: Principal,
    origin: string | undefined,
    use: (
      executor: Effect.Success<ReturnType<typeof makeScopedExecutor>>,
    ) => Effect.Effect<A, unknown>,
  ) =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor(
        principal.accountId,
        principal.organizationId,
        principal.organizationName,
        { orgWrites: orgWriteAccessForPrincipal(principal) },
      );
      return yield* withWriteAccess(use(executor), principal);
    }).pipe(Effect.provide(executorLayer, { local: true }), (effect) => withOrigin(effect, origin));

  const withStack = <A>(
    principal: Principal,
    origin: string | undefined,
    use: (
      stack: Effect.Success<ReturnType<typeof makeExecutionStack>>,
    ) => Effect.Effect<A, unknown>,
  ) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => preloadQuickJs());
      const stack = yield* makeExecutionStack(
        principal.accountId,
        principal.organizationId,
        principal.organizationName,
        { orgWrites: orgWriteAccessForPrincipal(principal) },
      );
      return yield* withWriteAccess(use(stack), principal);
    }).pipe(Effect.provide(stackLayer, { local: true }), (effect) => withOrigin(effect, origin));

  const search = (principal: Principal, input: unknown, origin?: string) => {
    const decoded = decodeSearch(input);
    if (Option.isNone(decoded)) {
      return Promise.resolve<SearchToolsResult>({
        status: "invalid_arguments",
        message: "Invalid search body",
      });
    }
    const params = decoded.value;
    return Effect.runPromise(
      withExecutor(principal, origin, (executor) =>
        searchPassthroughTools(executor.tools, makeCloudflareToolDiscovery(config, principal), {
          query: params.query,
          integration: params.integration,
          integrations: params.integrations,
          owner: params.owner,
          connection: params.connection,
          limit: params.limit ?? PASSTHROUGH_SEARCH_LIMIT_DEFAULT,
          offset: params.offset ?? 0,
        }),
      ),
    );
  };

  const overview = (principal: Principal, origin?: string) =>
    Effect.runPromise(
      withExecutor(principal, origin, (executor) =>
        passthroughOverview(executor.integrations, executor.tools),
      ),
    );

  const invoke = (principal: Principal, input: unknown, origin?: string) => {
    const decoded = decodeInvoke(input);
    if (Option.isNone(decoded)) {
      return Promise.resolve<InvokeToolResult>({
        status: "invalid_arguments",
        message: "Invalid invoke body",
      });
    }
    const { tool, arguments: args, approved = false } = decoded.value;
    return Effect.runPromise(
      withStack(
        principal,
        origin,
        ({ executor, engine }): Effect.Effect<InvokeToolResult, unknown> =>
          Effect.gen(function* () {
            const target = yield* resolvePassthroughTarget(executor.tools, validator, tool, args);
            if (target.status === "unavailable") {
              return {
                status: "unavailable",
                message: "Tool not found or blocked by policy. Search for an available tool.",
              };
            }
            if (target.status === "invalid_arguments") {
              return { status: "invalid_arguments", message: target.message };
            }
            const call = yield* runPassthroughCall({
              engine,
              address: target.address,
              args: target.args,
              policyApproved: approved,
            });
            return Match.value(call).pipe(
              Match.when(
                { status: "approval_required" },
                (pending): InvokeToolResult => ({
                  status: "approval_required",
                  tool,
                  message: pending.message,
                }),
              ),
              Match.when(
                { status: "input_required" },
                (input): InvokeToolResult => ({
                  status: "input_required",
                  tool,
                  message: requestMessage(input.request),
                }),
              ),
              Match.when(
                { status: "blocked" },
                (blocked): InvokeToolResult => ({
                  status: "blocked",
                  tool,
                  message: blocked.message,
                }),
              ),
              Match.when(
                { status: "error" },
                (failed): InvokeToolResult => ({
                  status: "error",
                  error: failed.error,
                  logs: failed.logs,
                }),
              ),
              Match.when(
                { status: "ok" },
                (ok): InvokeToolResult => ({ status: "ok", ...boundPassthroughResult(ok.result) }),
              ),
              Match.exhaustive,
            );
          }),
      ),
    );
  };

  return { search, invoke, overview };
};
