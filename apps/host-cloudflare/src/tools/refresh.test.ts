import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
} from "@executor-js/sdk";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { makeAnnotationsMcpServer } from "@executor-js/plugin-mcp/testing";

import { refreshCatalog, type RefreshCatalogResult } from "./refresh";

const INTERNAL = new Set(["tools.internal"]);

const annotationsBinding = () => ({
  fetch: async (request: Request) => {
    const server = makeAnnotationsMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
});

const makeExecutor = (endpoint: string) =>
  createExecutor({
    ...makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
    httpClientLayer: makeHostedHttpClientLayer({
      internalHosts: { "tools.internal": annotationsBinding() },
    }),
  }).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.mcp.addServer({ name: "dyn", endpoint, slug: "dyn" });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("dyn"),
          template: AuthTemplateSlug.make("none"),
          value: "",
        });
      }),
    ),
  );

describe("refreshCatalog", () => {
  it.live("returns each refreshed tool with the approval flag its destructiveHint implies", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor("https://tools.internal/mcp/dyn");

      const result = yield* refreshCatalog(executor, INTERNAL, { integration: "dyn" });

      expect(result).toEqual({
        ok: true,
        count: 5,
        tools: [
          { id: "tools.dyn.org.main.delete", name: "delete", requiresApproval: true },
          { id: "tools.dyn.org.main.delete_titled", name: "delete_titled", requiresApproval: true },
          { id: "tools.dyn.org.main.list", name: "list", requiresApproval: false },
          { id: "tools.dyn.org.main.ping", name: "ping", requiresApproval: false },
          { id: "tools.dyn.org.main.meta_stamped", name: "meta_stamped", requiresApproval: false },
        ],
      });
    }),
  );

  it.live("a destructive tool is gated on the first refresh and after a second one", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor("https://tools.internal/mcp/dyn");
      const gated = (r: RefreshCatalogResult) =>
        r.ok ? r.tools.filter((tool) => tool.requiresApproval).map((tool) => tool.name) : [];

      const first = yield* refreshCatalog(executor, INTERNAL, { integration: "dyn" });
      const second = yield* refreshCatalog(executor, INTERNAL, { integration: "dyn" });
      const listed = yield* executor.tools.list({ integration: IntegrationSlug.make("dyn") });

      expect(gated(first)).toEqual(["delete", "delete_titled"]);
      expect(gated(second)).toEqual(["delete", "delete_titled"]);
      expect(
        listed.filter((tool) => tool.annotations?.requiresApproval === true).map((t) => t.name),
      ).toEqual(["delete", "delete_titled"]);
    }),
  );

  it.live("refuses an integration that is not behind a configured internal host", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor("https://tools.internal/mcp/dyn");

      const result = yield* refreshCatalog(executor, new Set(["other.internal"]), {
        integration: "dyn",
      });

      expect(result).toEqual({
        ok: false,
        status: "unavailable",
        message: "Not an integration behind an internal host",
      });
    }),
  );

  it.live("reports an unknown integration as unavailable and a bad input as invalid", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor("https://tools.internal/mcp/dyn");

      const unknown = yield* refreshCatalog(executor, INTERNAL, { integration: "nope" });
      const invalid = yield* refreshCatalog(executor, INTERNAL, { connection: "other" });

      expect(unknown).toMatchObject({ ok: false, status: "unavailable" });
      expect(invalid).toMatchObject({ ok: false, status: "invalid_arguments" });
    }),
  );
});
