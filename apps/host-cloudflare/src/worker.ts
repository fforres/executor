import { WorkerEntrypoint } from "cloudflare:workers";

import type { Principal } from "@executor-js/api/server";
import type { PassthroughOverview } from "@executor-js/host-mcp/passthrough-api";

import { makeCloudflareApp } from "./app";
import { ownerPrincipal } from "./auth/cloudflare-access";
import { loadConfigResult, type CloudflareEnv } from "./config";
import { createD1ExecutorDb } from "./db/d1";
import { mcpResourceFromPath } from "./mcp/resource";
import {
  makeCloudflareToolsService,
  type InvokeToolResult,
  type RefreshCatalogResult,
  type SearchToolsResult,
  type ToolsService,
} from "./tools/service";

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` and `/mcp/toolkits/:slug` stay at this edge boundary because
// `McpAgent.serve()` needs the Cloudflare `ExecutionContext` to pass
// authenticated session props into the hibernatable Durable Object bridge.
//
// Two doors:
//   - the default `fetch` is the PUBLIC door: every request must present an API
//     key or an Access JWT.
//   - `ExecutorInternal` is the service-binding door, RPC only: workers in the
//     same account reach it through a `services` binding with
//     `entrypoint: "ExecutorInternal"` and call `searchTools`, `invokeTool` and
//     `overview` (and `refreshCatalog`, for integrations behind an internal host) as the owner with no credential. It has no `fetch`, builds its
//     OWN config marked `trustedInternal`, and calls the tool service directly;
//     nothing in `env` or in a request can switch the public door into that mode.
// ---------------------------------------------------------------------------

interface Serve {
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}

const memoize = <A>(build: (env: CloudflareEnv) => Promise<A>) => {
  let promise: Promise<A> | null = null;
  return (env: CloudflareEnv): Promise<A> => (promise ??= build(env));
};

/** One opened D1 handle per isolate, shared by both doors. */
const sharedDb = memoize((env) => createD1ExecutorDb(env.DB, env.BLOBS));

type Resolved<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

const resolvePublic = memoize(async (env): Promise<Resolved<Serve>> => {
  const loaded = loadConfigResult(env);
  if (!loaded.ok) return loaded;
  const { toWebHandler, mcpAgentHandler } = await makeCloudflareApp(
    env,
    loaded.config,
    await sharedDb(env),
  );
  return { ok: true, value: { app: toWebHandler().handler, mcp: mcpAgentHandler } };
});

interface InternalTools extends ToolsService {
  readonly owner: Principal;
}

const resolveInternal = memoize(async (env): Promise<Resolved<InternalTools>> => {
  const loaded = loadConfigResult(env, { internal: true });
  if (!loaded.ok) return loaded;
  const service = makeCloudflareToolsService(loaded.config, await sharedDb(env));
  return {
    ok: true,
    value: { ...service, owner: ownerPrincipal(loaded.config, "Internal service binding") },
  };
});

const internalTools = async (env: CloudflareEnv): Promise<InternalTools> => {
  const resolved = await resolveInternal(env);
  if (resolved.ok) return resolved.value;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: an RPC caller gets a rejection, not a half-configured owner
  throw new Error(resolved.message);
};

const configErrorResponse = (message: string): Response =>
  new Response(`${message}\n`, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const route = async (
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
  serve: Serve,
): Promise<Response> => {
  const resource = mcpResourceFromPath(new URL(request.url).pathname);
  if (resource !== null) {
    return serve.mcp(request, env, ctx);
  }
  return serve.app(request);
};

export const handlePublicRequest = async (
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<Response> => {
  const resolved = await resolvePublic(env);
  if (!resolved.ok) return configErrorResponse(resolved.message);
  return route(request, env, ctx, resolved.value);
};

/**
 * The service-binding door: RPC methods only. Reachable only through a `services`
 * binding from a worker in the same account; the platform offers it no public
 * route. Calls act as the owner (`API_KEY_PRINCIPAL_EMAIL`), exactly like an API
 * key would.
 */
export class ExecutorInternal extends WorkerEntrypoint<CloudflareEnv> {
  /** Rank the catalog for `query`, optionally limited to the `integrations` slugs. */
  async searchTools(input: SearchToolsInput): Promise<SearchToolsResult> {
    const { owner, search } = await internalTools(this.env);
    return search(owner, input);
  }

  /** Run one tool by id; `approved: true` accepts a policy approval prompt. */
  async invokeTool(input: InvokeToolInput): Promise<InvokeToolResult> {
    const { owner, invoke } = await internalTools(this.env);
    return invoke(owner, input);
  }

  /** Integrations with their tool counts, without ranking or schemas. */
  async overview(): Promise<PassthroughOverview> {
    const { owner, overview } = await internalTools(this.env);
    return overview(owner);
  }

  /** Re-list an org connection's tools now, for integrations behind an internal host. */
  async refreshCatalog(input: RefreshCatalogInput): Promise<RefreshCatalogResult> {
    const { owner, refresh } = await internalTools(this.env);
    return refresh(owner, input);
  }
}

export interface SearchToolsInput {
  readonly query: string;
  readonly integrations?: readonly string[];
  readonly integration?: string;
  readonly owner?: "org" | "user";
  readonly connection?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RefreshCatalogInput {
  readonly integration: string;
  readonly connection?: "main";
}

export interface InvokeToolInput {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly approved?: boolean;
}

export default {
  fetch: handlePublicRequest,
};
