import { Effect, Option, Schema } from "effect";

import { IntegrationSlug, ConnectionName, type Executor } from "@executor-js/sdk";
import { isInternalHostname, normalizeHostname } from "@executor-js/sdk/host-internal";

// ---------------------------------------------------------------------------
// `refreshCatalog`: re-list one org connection's tools from its MCP server NOW
// instead of waiting for the freshness TTL, the same internal function the REST
// route `POST /api/connections/org/:integration/:name/refresh` calls
// (`executor.connections.refresh`). It is for integrations that live behind an
// internal service-binding host (`*.internal`), whose catalog a sibling worker
// changes at runtime (posse's dynamic workers); any other integration answers
// `unavailable`, so the RPC door cannot be used to dial arbitrary servers.
// ---------------------------------------------------------------------------

export const RefreshCatalogInput = Schema.Struct({
  integration: Schema.NonEmptyString,
  connection: Schema.optional(Schema.Literal("main")),
});

export interface RefreshedTool {
  readonly id: string;
  readonly name: string;
  readonly requiresApproval: boolean;
}

export type RefreshCatalogResult =
  | { readonly ok: true; readonly count: number; readonly tools: readonly RefreshedTool[] }
  | {
      readonly ok: false;
      readonly status: "unavailable" | "invalid_arguments";
      readonly message: string;
    };

const decodeInput = Schema.decodeUnknownOption(RefreshCatalogInput);

const hostnameOf = (url: string | undefined): string | null => {
  if (url === undefined) return null;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  return parsed === null ? null : normalizeHostname(parsed.hostname);
};

type RefreshableExecutor = Pick<Executor, "connections" | "integrations">;

export const refreshCatalog = (
  executor: RefreshableExecutor,
  internalHostnames: ReadonlySet<string>,
  input: unknown,
) =>
  Effect.gen(function* () {
    const decoded = decodeInput(input);
    if (Option.isNone(decoded)) {
      return {
        ok: false,
        status: "invalid_arguments",
        message: "Invalid refreshCatalog input",
      } satisfies RefreshCatalogResult;
    }
    const slug = IntegrationSlug.make(decoded.value.integration);
    const integration = yield* executor.integrations.get(slug);
    const host = hostnameOf(integration?.displayUrl);
    if (
      integration === null ||
      host === null ||
      !isInternalHostname(host) ||
      !internalHostnames.has(host)
    ) {
      return {
        ok: false,
        status: "unavailable",
        message: "Not an integration behind an internal host",
      } satisfies RefreshCatalogResult;
    }
    const tools = yield* executor.connections
      .refresh({
        owner: "org",
        integration: slug,
        name: ConnectionName.make(decoded.value.connection ?? "main"),
      })
      .pipe(
        Effect.catchTags({
          ConnectionNotFoundError: () => Effect.succeed(null),
          IntegrationNotFoundError: () => Effect.succeed(null),
        }),
      );
    if (tools === null) {
      return {
        ok: false,
        status: "unavailable",
        message: "No such connection",
      } satisfies RefreshCatalogResult;
    }
    return {
      ok: true,
      count: tools.length,
      tools: tools.map(
        (tool): RefreshedTool => ({
          id: String(tool.address),
          name: String(tool.name),
          requiresApproval: tool.annotations?.requiresApproval === true,
        }),
      ),
    } satisfies RefreshCatalogResult;
  });
