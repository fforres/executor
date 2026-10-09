import { Effect } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import {
  dbProviderLayer,
  ExecutorApp,
  textFailureStrategy,
  type ExecutorDbHandle,
} from "@executor-js/api/server";

import { loadConfig, type CloudflareConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { createD1ExecutorDb } from "./db/d1";
import { cloudflareAccessIdentityLayer } from "./auth/cloudflare-access";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareApprovalHandler } from "./mcp";
import { makeCloudflareToolsHandler } from "./tools/rest";
import { makeCloudflareToolsService } from "./tools/service";
import { makeCloudflareMcpAgentHandler } from "./mcp/agent-handler";
import { preloadQuickJs } from "./quickjs";

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call: the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: Cloudflare Access is the identity (validate
// the Cf-Access-Jwt-Assertion JWT, no Better Auth, no WorkOS, no app login),
// D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS is the
// in-process code substrate, no billing, single-tenant. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

export const makeCloudflareApp = async (
  env: CloudflareEnv,
  config: CloudflareConfig = loadConfig(env),
  /** The opened D1 handle, when the caller already has one to share. */
  sharedDbHandle?: ExecutorDbHandle,
) => {
  const plugins = makeCloudflarePlugins(config.secretKey, {
    mcpActiveWorkTimeoutMs: config.mcpActiveWorkTimeoutMs,
  });

  // Load the Workers-compatible (WASM-inlined) QuickJS variant before any
  // executor is built, the default variant cannot fetch its .wasm on Workers.
  await preloadQuickJs();

  // Open and idempotently bring up the D1 schema once. This is the long-lived
  // handle the per-request scoped executor reads through the DbProvider seam.
  const dbHandle = sharedDbHandle ?? (await createD1ExecutorDb(env.DB, env.BLOBS));
  const identityLayer = cloudflareAccessIdentityLayer(config);
  const mcpAgentHandler = makeCloudflareMcpAgentHandler(config);
  const approvalHandler = makeCloudflareApprovalHandler(config, env);
  const toolsHandler = makeCloudflareToolsHandler(
    config,
    makeCloudflareToolsService(config, dbHandle),
  );

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(dbHandle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider },
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      // The account API (`/api/account/*`) backs the shared multiplayer shell's
      // auth context; `me` reflects the Access principal. Members/keys are
      // Access-managed, so the rest of the surface is stubbed.
      account: cloudflareAccountMiddleware(config),
    },
    extensions: {
      routes: [
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // Access-gated, routed to the owning session's Durable Object.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(approvalHandler)),
        // REST search/overview/invoke for non-MCP callers (agents, posse): ranked
        // tool discovery, the catalog overview and single-tool invocation,
        // authenticated by the composite auth.
        HttpRouter.add("*", "/api/tools/search", HttpEffect.fromWebHandler(toolsHandler)),
        HttpRouter.add("*", "/api/tools/overview", HttpEffect.fromWebHandler(toolsHandler)),
        HttpRouter.add("*", "/api/tools/invoke", HttpEffect.fromWebHandler(toolsHandler)),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: identityLayer,
  });

  return { appLayer, toWebHandler, mcpAgentHandler };
};
