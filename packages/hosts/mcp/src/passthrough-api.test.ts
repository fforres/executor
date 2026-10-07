import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ToolDiscoveryInput, ToolDiscoveryProvider } from "@executor-js/execution";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  ToolName,
  type Tool,
  type ToolSchemaView,
} from "@executor-js/sdk";

import {
  CfWorkerJsonSchemaValidator,
  resolvePassthroughTarget,
  searchPassthroughTools,
} from "./passthrough-api";
import type { McpToolsPort } from "./passthrough-api";

const tool = (integration: string, name: string, extra: Partial<Tool> = {}): Tool => ({
  address: ToolAddress.make(`tools.${integration}.org.main.${name}`),
  integration: IntegrationSlug.make(integration),
  owner: "org",
  connection: ConnectionName.make("main"),
  name: ToolName.make(name),
  pluginId: "test",
  description: `${integration} ${name}`,
  ...extra,
});

const CATALOG = [
  tool("linear", "issues_list", {
    inputSchema: { type: "object", properties: { team: { type: "string" } }, required: ["team"] },
    annotations: { readOnlyHint: true },
  }),
  tool("github", "pulls_create", {
    annotations: { requiresApproval: true, destructiveHint: true },
  }),
  tool("config", "static_tool", { static: true }),
];

const port: McpToolsPort = {
  list: (filter) =>
    Effect.succeed(
      CATALOG.filter(
        (item) => filter?.integration === undefined || item.integration === filter.integration,
      ),
    ),
  schema: (address) =>
    Effect.sync(() => {
      const found = CATALOG.find((item) => item.address === address);
      return found
        ? ({
            address,
            name: found.name,
            description: found.description,
            inputSchema: found.inputSchema,
            annotations: found.annotations,
          } satisfies ToolSchemaView)
        : null;
    }),
};

describe("searchPassthroughTools", () => {
  it.effect(
    "ranks through the given provider and keeps its ranked flag, schemas and annotations",
    () =>
      Effect.gen(function* () {
        const seen: ToolDiscoveryInput[] = [];
        const provider: ToolDiscoveryProvider = {
          searchTools: (input) =>
            Effect.gen(function* () {
              seen.push(input);
              const all = yield* input.executor.tools.list({ includeAnnotations: false });
              return {
                items: all.map((item, index) => ({
                  path: String(item.address).replace(/^tools\./, ""),
                  name: String(item.name),
                  integration: String(item.integration),
                  score: 90 - index,
                  description: item.description,
                })),
                total: all.length,
                hasMore: false,
                nextOffset: null,
                ranked: false,
              };
            }),
        };
        const result = yield* searchPassthroughTools(port, provider, {
          query: "open issues",
          limit: 10,
          offset: 0,
        });
        expect(result.ranked).toBe(false);
        // The static configuration tool is filtered out before the provider sees it.
        expect(result.items.map((item) => item.id)).toEqual([
          "tools.linear.org.main.issues_list",
          "tools.github.org.main.pulls_create",
        ]);
        expect(result.items[0]).toMatchObject({
          inputSchema: { required: ["team"] },
          annotations: { readOnlyHint: true },
        });
        expect(result.items[1]?.annotations).toEqual({
          requiresApproval: true,
          destructiveHint: true,
        });
      }),
  );

  it.effect("names the filter as the cache scope and applies it to the catalog", () =>
    Effect.gen(function* () {
      const scopes: (string | undefined)[] = [];
      const provider: ToolDiscoveryProvider = {
        searchTools: (input) =>
          Effect.gen(function* () {
            scopes.push(input.scope);
            const all = yield* input.executor.tools.list({ includeAnnotations: false });
            return { items: [], total: all.length, hasMore: false, nextOffset: null };
          }),
      };
      const result = yield* searchPassthroughTools(port, provider, {
        query: "x",
        integration: "github",
        limit: 5,
        offset: 0,
      });
      expect(scopes).toEqual(['["github",null,null]']);
      expect(result.total).toBe(1);
    }),
  );
});

describe("resolvePassthroughTarget", () => {
  const validator = new CfWorkerJsonSchemaValidator();

  it.effect("is ready for a visible tool with valid arguments", () =>
    Effect.gen(function* () {
      const target = yield* resolvePassthroughTarget(
        port,
        validator,
        "tools.linear.org.main.issues_list",
        { team: "ENG" },
      );
      expect(target).toEqual({
        status: "ready",
        address: "tools.linear.org.main.issues_list",
        args: { team: "ENG" },
      });
    }),
  );

  it.effect("reports invalid arguments and unavailable tools distinctly", () =>
    Effect.gen(function* () {
      const invalid = yield* resolvePassthroughTarget(
        port,
        validator,
        "tools.linear.org.main.issues_list",
        {},
      );
      expect(invalid.status).toBe("invalid_arguments");
      const missing = yield* resolvePassthroughTarget(
        port,
        validator,
        "tools.linear.org.main.nope",
        {},
      );
      expect(missing).toEqual({ status: "unavailable" });
      const notAnAddress = yield* resolvePassthroughTarget(port, validator, "garbage", {});
      expect(notAnAddress).toEqual({ status: "unavailable" });
    }),
  );
});
