import { Validator } from "@cfworker/json-schema";
import { Effect, Predicate } from "effect";
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
  parseToolAddress,
  type Executor,
  type ToolAnnotations,
  type ToolSchemaView,
} from "@executor-js/sdk";
import type { PagedResult, ToolDiscoveryProvider } from "@executor-js/execution";

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

export interface PassthroughSearchParams {
  readonly query: string;
  readonly integration?: string | undefined;
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
    const { query, integration, owner, connection, limit, offset } = params;
    const discovery = {
      tools: {
        list: (filter?: Parameters<McpToolsPort["list"]>[0]) =>
          tools
            .list({
              ...filter,
              ...(integration === undefined
                ? {}
                : { integration: IntegrationSlug.make(integration) }),
              ...(owner === undefined ? {} : { owner }),
              ...(connection === undefined ? {} : { connection: ConnectionName.make(connection) }),
            })
            .pipe(Effect.map((items) => items.filter((tool) => tool.static !== true))),
      },
    };
    // Through the configured provider, not the raw ranker: passthrough search
    // must rank the same way codemode's `tools.search` does.
    const page = yield* provider.searchTools({
      executor: discovery,
      scope: JSON.stringify([integration ?? null, owner ?? null, connection ?? null]),
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
