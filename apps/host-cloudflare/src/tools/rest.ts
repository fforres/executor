import { Effect, Option, Schema } from "effect";

import {
  makeExecutionStack,
  RequestWebOrigin,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";
import {
  CfWorkerJsonSchemaValidator,
  resolvePassthroughTarget,
  searchPassthroughTools,
} from "@executor-js/host-mcp/passthrough-api";
import { passthroughCallCode } from "@executor-js/host-mcp/passthrough-tools";
import {
  CurrentOrgWriteAccess,
  isToolResult,
  makeOrgWriteAccessState,
  type ElicitationHandler,
  type ElicitationRequest,
} from "@executor-js/sdk";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";
import { makeCloudflareExecutionStackLayer } from "../execution";
import { preloadQuickJs } from "../quickjs";

// ---------------------------------------------------------------------------
// REST search/invoke over the passthrough core: `POST /api/tools/search` ranks
// through the host's discovery provider (Clef) and `POST /api/tools/invoke` runs
// one tool through the same engine path as the MCP passthrough `invoke`. The
// caller is authenticated by the composite auth (API key, Access, or the
// internal service binding) and acts as that principal.
//
// MCP clients gate `invoke` natively; a REST client has no such gate, so a call
// the workspace policy marks as requiring approval does NOT run until the caller
// sends the same request again with `approved: true`. Until then it answers
// `approval_required` with what would run. Blocked tools answer `blocked`.
// ---------------------------------------------------------------------------

const SearchBody = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  integration: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  owner: Schema.optionalKey(Schema.Literals(["org", "user"])),
  connection: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 })),
  ),
  offset: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});

const InvokeBody = Schema.Struct({
  tool: Schema.String.check(Schema.isMinLength(1)),
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  approved: Schema.optionalKey(Schema.Boolean),
});

const decodeSearch = Schema.decodeUnknownOption(SearchBody);
const decodeInvoke = Schema.decodeUnknownOption(InvokeBody);

const SEARCH_PATH = "/api/tools/search";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const readJson = (request: Request): Effect.Effect<unknown> =>
  Effect.tryPromise({ try: () => request.json(), catch: () => null }).pipe(
    Effect.orElseSucceed(() => null),
  );

const requestMessage = (request: ElicitationRequest): string => request.message;

export type ToolsRestResult =
  | { readonly status: "ok"; readonly result: unknown }
  | { readonly status: "approval_required"; readonly tool: string; readonly message: string }
  | { readonly status: "blocked"; readonly tool: string; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "invalid_arguments"; readonly message: string }
  | { readonly status: "input_required"; readonly tool: string; readonly message: string }
  | { readonly status: "error"; readonly error: unknown; readonly logs: readonly string[] };

const HTTP_STATUS: Record<ToolsRestResult["status"], number> = {
  ok: 200,
  approval_required: 202,
  blocked: 403,
  unavailable: 404,
  invalid_arguments: 400,
  input_required: 409,
  error: 502,
};

export const makeCloudflareToolsHandler = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): ((request: Request) => Promise<Response>) => {
  const { verify } = makeAccessVerifier(config);
  const validator = new CfWorkerJsonSchemaValidator();
  const stackLayer = makeCloudflareExecutionStackLayer(config, dbHandle);

  const withStack = <A>(
    request: Request,
    principal: NonNullable<Effect.Success<ReturnType<typeof verify>>>,
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
      ).pipe(
        Effect.provide(stackLayer, { local: true }),
        Effect.provideService(RequestWebOrigin, { origin: new URL(request.url).origin }),
      );
      return yield* use(stack).pipe(
        Effect.provideService(
          CurrentOrgWriteAccess,
          makeOrgWriteAccessState(orgWriteAccessForPrincipal(principal)),
        ),
      );
    });

  const search = (request: Request, principal: Parameters<typeof withStack>[1], body: unknown) => {
    const decoded = decodeSearch(body);
    if (Option.isNone(decoded)) {
      return Effect.succeed(
        json({ status: "invalid_arguments", message: "Invalid search body" }, 400),
      );
    }
    const params = decoded.value;
    return withStack(request, principal, ({ executor, toolDiscoveryProvider }) =>
      searchPassthroughTools(executor.tools, toolDiscoveryProvider, {
        query: params.query,
        integration: params.integration,
        owner: params.owner,
        connection: params.connection,
        limit: params.limit ?? 10,
        offset: params.offset ?? 0,
      }),
    ).pipe(Effect.map((result) => json(result)));
  };

  const invoke = (request: Request, principal: Parameters<typeof withStack>[1], body: unknown) => {
    const decoded = decodeInvoke(body);
    if (Option.isNone(decoded)) {
      return Effect.succeed(
        json({ status: "invalid_arguments", message: "Invalid invoke body" }, 400),
      );
    }
    const { tool, arguments: args, approved = false } = decoded.value;
    return withStack(
      request,
      principal,
      ({ executor, engine }): Effect.Effect<ToolsRestResult, unknown> =>
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

          let approval: string | undefined;
          let inputRequired: string | undefined;
          const onElicitation: ElicitationHandler = (ctx) => {
            if (ctx.source === "policy") {
              if (approved) return Effect.succeed({ action: "accept" as const, content: {} });
              approval = requestMessage(ctx.request);
              return Effect.succeed({ action: "decline" as const });
            }
            inputRequired = requestMessage(ctx.request);
            return Effect.succeed({ action: "decline" as const });
          };

          const outcome = yield* engine.execute(passthroughCallCode(target.address, target.args), {
            onElicitation,
          });
          if (approval !== undefined) {
            return { status: "approval_required", tool, message: approval };
          }
          if (inputRequired !== undefined) {
            return { status: "input_required", tool, message: inputRequired };
          }
          const value = outcome.result;
          if (outcome.error || !isToolResult(value)) {
            return outcome.error
              ? { status: "error", error: outcome.error, logs: outcome.logs ?? [] }
              : { status: "ok", result: value };
          }
          if (value.ok) return { status: "ok", result: value.data };
          if (value.error.code === "tool_blocked") {
            return { status: "blocked", tool, message: value.error.message };
          }
          return { status: "error", error: value.error, logs: outcome.logs ?? [] };
        }),
    ).pipe(Effect.map((result) => json(result, HTTP_STATUS[result.status])));
  };

  return (request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const principal = yield* verify(request);
        if (!principal) return json({ error: "Unauthorized" }, 401);
        const { pathname } = new URL(request.url);
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const body = yield* readJson(request);
        return pathname === SEARCH_PATH
          ? yield* search(request, principal, body)
          : yield* invoke(request, principal, body);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error("[executor-cloudflare] tools route failed", cause);
            return json({ error: "Internal error" }, 500);
          }),
        ),
      ),
    );
};
