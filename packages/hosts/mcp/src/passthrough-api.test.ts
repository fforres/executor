import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  ExecutionEngine,
  ToolDiscoveryInput,
  ToolDiscoveryProvider,
} from "@executor-js/execution";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  ToolName,
  type Tool,
  type ToolSchemaView,
} from "@executor-js/sdk";

import {
  boundPassthroughResult,
  CfWorkerJsonSchemaValidator,
  passthroughOverview,
  resolvePassthroughTarget,
  runPassthroughCall,
  searchPassthroughTools,
} from "./passthrough-api";
import type { McpToolsPort } from "./passthrough-api";

type ExecuteFn = ExecutionEngine["execute"];

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
    annotations: { mayElicit: true },
  }),
  tool("github", "pulls_create", {
    annotations: { requiresApproval: true, approvalDescription: "Opens a pull request" },
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
              const all = yield* input.executor.tools
                .list({ includeAnnotations: false })
                .pipe(Effect.orDie);
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
          annotations: { mayElicit: true },
        });
        expect(result.items[1]?.annotations).toEqual({
          requiresApproval: true,
          approvalDescription: "Opens a pull request",
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
            const all = yield* input.executor.tools
              .list({ includeAnnotations: false })
              .pipe(Effect.orDie);
            return { items: [], total: all.length, hasMore: false, nextOffset: null };
          }),
      };
      const result = yield* searchPassthroughTools(port, provider, {
        query: "x",
        integration: "github",
        limit: 5,
        offset: 0,
      });
      expect(scopes).toEqual(["[null,null]"]);
      expect(result.total).toBe(1);
    }),
  );

  const countingPort = (listed: Array<Parameters<McpToolsPort["list"]>[0]>): McpToolsPort => ({
    ...port,
    list: (filter) => {
      listed.push(filter);
      return port.list(filter);
    },
  });
  const listAllProvider = (seen: ToolDiscoveryInput[]): ToolDiscoveryProvider => ({
    searchTools: (input) =>
      Effect.gen(function* () {
        seen.push(input);
        const all = yield* input.executor.tools
          .list({ includeAnnotations: false })
          .pipe(Effect.orDie);
        return {
          items: all.map((item) => ({
            path: String(item.address).replace(/^tools\./, ""),
            name: String(item.name),
            integration: String(item.integration),
            score: 50,
          })),
          total: all.length,
          hasMore: false,
          nextOffset: null,
        };
      }),
  });

  it.effect("pushes a single allowed integration into one catalog listing", () =>
    Effect.gen(function* () {
      const listed: Array<Parameters<McpToolsPort["list"]>[0]> = [];
      const seen: ToolDiscoveryInput[] = [];
      const result = yield* searchPassthroughTools(countingPort(listed), listAllProvider(seen), {
        query: "x",
        integrations: ["github"],
        limit: 5,
        offset: 0,
      });
      expect(listed).toEqual([{ includeAnnotations: false, integration: "github" }]);
      expect(seen[0]?.integrations).toEqual(["github"]);
      expect(result.items.map((item) => item.integration)).toEqual(["github"]);
    }),
  );

  it.effect("ranks once over the catalog restricted to several allowed integrations", () =>
    Effect.gen(function* () {
      const listed: Array<Parameters<McpToolsPort["list"]>[0]> = [];
      const seen: ToolDiscoveryInput[] = [];
      const result = yield* searchPassthroughTools(countingPort(listed), listAllProvider(seen), {
        query: "x",
        integrations: ["linear", "github", "linear"],
        limit: 5,
        offset: 0,
      });
      expect(seen).toHaveLength(1);
      expect(listed).toHaveLength(1);
      expect(seen[0]?.integrations).toEqual(["github", "linear"]);
      expect(result.items.map((item) => item.integration).sort()).toEqual(["github", "linear"]);
    }),
  );

  it.effect("returns nothing, without ranking, for an empty allow list", () =>
    Effect.gen(function* () {
      const seen: ToolDiscoveryInput[] = [];
      const result = yield* searchPassthroughTools(port, listAllProvider(seen), {
        query: "x",
        integrations: [],
        limit: 5,
        offset: 0,
      });
      expect(seen).toHaveLength(0);
      expect(result).toMatchObject({ items: [], total: 0, hasMore: false });
    }),
  );

  it.effect("intersects `integration` with the allow list", () =>
    Effect.gen(function* () {
      const seen: ToolDiscoveryInput[] = [];
      const result = yield* searchPassthroughTools(port, listAllProvider(seen), {
        query: "x",
        integration: "github",
        integrations: ["linear"],
        limit: 5,
        offset: 0,
      });
      expect(result.items).toEqual([]);
    }),
  );
});

describe("passthroughOverview", () => {
  const integration = (slug: string, kind: string, description: string) => ({
    slug: IntegrationSlug.make(slug),
    name: slug.toUpperCase(),
    description,
    kind,
    canRemove: true,
    canRefresh: false,
    authMethods: [],
  });

  it.effect("counts visible tools per integration and leaves out the built-in one", () =>
    Effect.gen(function* () {
      const result = yield* passthroughOverview(
        {
          list: () =>
            Effect.succeed([
              integration("executor", "built-in", "Executor itself"),
              integration("github", "openapi", "Repositories and pull requests"),
              integration("linear", "mcp", "LINEAR"),
              integration("empty", "mcp", "Nothing yet"),
            ]),
        },
        port,
      );
      expect(result).toEqual({
        integrations: [
          { slug: "empty", name: "EMPTY", description: "Nothing yet", toolCount: 0 },
          {
            slug: "github",
            name: "GITHUB",
            description: "Repositories and pull requests",
            toolCount: 1,
          },
          { slug: "linear", name: "LINEAR", toolCount: 1 },
        ],
        toolCount: 2,
      });
    }),
  );
});

describe("runPassthroughCall", () => {
  const address = ToolAddress.make("tools.github.org.main.pulls_create");
  const engineReturning = (
    result: unknown,
    elicit?: (onElicitation: Parameters<ExecuteFn>[1]["onElicitation"]) => Effect.Effect<void>,
  ) => ({
    execute: ((_code: string, options: Parameters<ExecuteFn>[1]) =>
      Effect.gen(function* () {
        if (elicit) yield* elicit(options.onElicitation);
        return { result, logs: ["l1"] };
      })) as ExecuteFn,
  });
  const policyPrompt = (onElicitation: Parameters<ExecuteFn>[1]["onElicitation"]) =>
    onElicitation({
      address,
      args: {},
      source: "policy",
      request: { _tag: "FormElicitation", message: "Open a pull request?", requestedSchema: {} },
    }).pipe(Effect.asVoid);

  it.effect("reports approval_required and declines the prompt unless approved", () =>
    Effect.gen(function* () {
      const result = yield* runPassthroughCall({
        engine: engineReturning({ ok: true, data: 1 }, policyPrompt),
        address,
        args: {},
        policyApproved: false,
      });
      expect(result).toEqual({ status: "approval_required", message: "Open a pull request?" });
    }),
  );

  it.effect("accepts the policy prompt when approved and unwraps the tool data", () =>
    Effect.gen(function* () {
      const result = yield* runPassthroughCall({
        engine: engineReturning({ ok: true, data: { number: 7 } }, policyPrompt),
        address,
        args: {},
        policyApproved: true,
      });
      expect(result).toMatchObject({ status: "ok", result: { number: 7 } });
    }),
  );

  it.effect("reports input_required for a tool prompt nobody can answer", () =>
    Effect.gen(function* () {
      const result = yield* runPassthroughCall({
        engine: engineReturning({ ok: true, data: 1 }, (onElicitation) =>
          onElicitation({
            address,
            args: {},
            source: "tool",
            request: { _tag: "FormElicitation", message: "Which repo?", requestedSchema: {} },
          }).pipe(Effect.asVoid),
        ),
        address,
        args: {},
        policyApproved: true,
      });
      expect(result).toMatchObject({
        status: "input_required",
        request: { message: "Which repo?" },
      });
    }),
  );

  it.effect("maps a blocked tool and a failed tool apart", () =>
    Effect.gen(function* () {
      const blocked = yield* runPassthroughCall({
        engine: engineReturning({ ok: false, error: { code: "tool_blocked", message: "Blocked" } }),
        address,
        args: {},
        policyApproved: true,
      });
      expect(blocked).toMatchObject({ status: "blocked", message: "Blocked" });
      const failed = yield* runPassthroughCall({
        engine: engineReturning({ ok: false, error: { code: "http_404", message: "Nope" } }),
        address,
        args: {},
        policyApproved: true,
      });
      expect(failed).toMatchObject({
        status: "error",
        error: { code: "http_404" },
        logs: ["l1"],
      });
    }),
  );
});

describe("boundPassthroughResult", () => {
  it("keeps a result that fits", () => {
    expect(boundPassthroughResult({ a: 1 }, 100)).toEqual({ result: { a: 1 } });
  });

  it("cuts an oversized result to bounded text and reports the original length", () => {
    expect(boundPassthroughResult({ items: ["aaaa", "bbbb"] }, 10)).toEqual({
      result: '{"items":[',
      truncated: true,
      originalLength: 25,
    });
  });
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
