import { WorkerEntrypoint } from "cloudflare:workers";

import { makeCloudflareApp } from "./app";
import {
  cloudflareConfigProblem,
  internalConfigProblem,
  loadConfig,
  type CloudflareEnv,
} from "./config";
import { mcpResourceFromPath } from "./mcp/resource";

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` and `/mcp/toolkits/:slug` stay at this edge boundary because
// `McpAgent.serve()` needs the Cloudflare `ExecutionContext` to pass
// authenticated session props into the hibernatable Durable Object bridge.
//
// Two doors share that machinery:
//   - the default `fetch` is the PUBLIC door: every request must present an API
//     key or an Access JWT.
//   - `ExecutorInternal` is the service-binding door: workers in the same account
//     reach it through a `services` binding with `entrypoint: "ExecutorInternal"`
//     and act as the owner with no credential. It builds its OWN app from a
//     config marked `trustedInternal`; nothing in `env` or in a request can switch
//     the public door into that mode.
// ---------------------------------------------------------------------------

interface Serve {
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}

const makeResolver = (internal: boolean) => {
  let promise: Promise<Serve> | null = null;
  return (env: CloudflareEnv): Promise<Serve> => {
    if (!promise) {
      promise = makeCloudflareApp(env, loadConfig(env, { internal })).then(
        ({ toWebHandler, mcpAgentHandler }) => ({
          app: toWebHandler().handler,
          mcp: mcpAgentHandler,
        }),
      );
    }
    return promise;
  };
};

const resolvePublic = makeResolver(false);
const resolveInternal = makeResolver(true);

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
  const configProblem = cloudflareConfigProblem(env);
  if (configProblem !== null) {
    return configErrorResponse(configProblem);
  }
  return route(request, env, ctx, await resolvePublic(env));
};

export const handleInternalRequest = async (
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<Response> => {
  const configProblem = internalConfigProblem(env);
  if (configProblem !== null) {
    return configErrorResponse(configProblem);
  }
  return route(request, env, ctx, await resolveInternal(env));
};

/**
 * The service-binding door. Reachable only through a `services` binding from a
 * worker in the same account; the platform offers it no public route. Requests
 * act as the owner (`API_KEY_PRINCIPAL_EMAIL`), exactly like an API key would.
 */
export class ExecutorInternal extends WorkerEntrypoint<CloudflareEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleInternalRequest(request, this.env, this.ctx);
  }

  /** RPC: `POST /api/tools/search`, returning `{ status, body }`. */
  searchTools(body: Record<string, unknown>): Promise<InternalRpcResult> {
    return this.callRoute("/api/tools/search", body);
  }

  /** RPC: `POST /api/tools/invoke`, returning `{ status, body }`. */
  invokeTool(body: Record<string, unknown>): Promise<InternalRpcResult> {
    return this.callRoute("/api/tools/invoke", body);
  }

  private async callRoute(path: string, body: Record<string, unknown>): Promise<InternalRpcResult> {
    const response = await handleInternalRequest(
      new Request(`https://executor.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      this.env,
      this.ctx,
    );
    return { status: response.status, body: await response.json() };
  }
}

export interface InternalRpcResult {
  readonly status: number;
  readonly body: unknown;
}

export default {
  fetch: handlePublicRequest,
};
