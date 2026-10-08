import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";

import { createMcpConnector } from "./connection";
import { discoverTools } from "./discover";
import { makeEchoMcpServer } from "../testing";

// A fake service binding that is a real (stateless) MCP server, so the full
// initialize and tools/list handshake crosses the internal route.
const mcpBinding = () => {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (request: Request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      const server = makeEchoMcpServer({ name: "websearch", toolName: "search" });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  };
};

describe("MCP over an internal service binding", () => {
  it.live("discovers the catalog of an integration at an internal host", () =>
    Effect.gen(function* () {
      const binding = mcpBinding();
      const manifest = yield* discoverTools(
        createMcpConnector({
          transport: "remote",
          endpoint: "https://tools.internal/mcp/websearch",
          remoteTransport: "streamable-http",
          httpClientLayer: makeHostedHttpClientLayer({
            internalHosts: { "tools.internal": binding },
          }),
        }),
      );

      expect(manifest.server?.name).toBe("websearch");
      expect(manifest.tools.map((tool) => tool.toolName)).toEqual(["search"]);
      expect(binding.seen.length).toBeGreaterThan(0);
      expect(binding.seen.every((call) => call.endsWith(" /mcp/websearch"))).toBe(true);
    }),
  );
});
