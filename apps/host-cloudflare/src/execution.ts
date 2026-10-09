import { Effect, Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  dbProviderLayer,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import {
  makeClefRankingCache,
  makeClefToolDiscoveryProvider,
  type ToolDiscoveryProvider,
} from "@executor-js/execution";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { env } from "cloudflare:workers";

import type { CloudflareConfig } from "./config";
import { makeCloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams — the same shape as self-host (QuickJS code
// substrate, no-op engine decorator), with the plugins + host config built from
// the per-request `env`-derived config rather than process.env.
//
// Code substrate: when the Worker declares a `worker_loaders` LOADER binding,
// use the dynamic-worker executor (cloud's substrate) — real isolates with
// `globalOutbound: null`. Without the binding, fall back to QuickJS-wasm,
// which runs in a single Worker with no extra binding.
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

export const CloudflareCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => {
    const loader = (env as { LOADER?: WorkerLoader }).LOADER;
    return loader ? makeDynamicWorkerExecutor({ loader }) : makeQuickJsExecutor();
  },
);

export const makeCloudflarePluginsProvider = (
  config: CloudflareConfig,
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: (context) =>
      makeCloudflarePlugins(config.secretKey, {
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
        allowLocalNetwork: config.allowLocalNetwork,
        mcpActiveWorkTimeoutMs: config.mcpActiveWorkTimeoutMs,
      }),
  });

// One ranking cache per isolate, shared by every request's provider (the cache
// key carries the subject).
const clefRankingCache = makeClefRankingCache();

/**
 * The tool-search ranker for one acting subject: Clef when the Workers AI
 * binding is bound, lexical (flagged `ranked: false`) otherwise.
 */
export const makeCloudflareToolDiscovery = (
  config: CloudflareConfig,
  subject: { readonly accountId: string; readonly organizationId: string },
): ToolDiscoveryProvider =>
  makeClefToolDiscoveryProvider({
    clef: config.clef,
    subject: `${subject.organizationId}\u0000${subject.accountId}`,
    cache: clefRankingCache,
  });

export const makeCloudflareHostConfig = (config: CloudflareConfig): Layer.Layer<HostConfig> =>
  Layer.succeed(HostConfig)({
    allowLocalNetwork: config.allowLocalNetwork,
    internalHosts: config.internalHosts,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
    toolDiscovery: (subject) => makeCloudflareToolDiscovery(config, subject),
  });

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer over the long-lived D1 handle. Mirrors self-host's
 * `SelfHostExecutionStackLayer`. The HTTP path wires these seams individually
 * through `ExecutorApp.make`; the MCP session store provides this whole Layer to
 * build a per-session engine off the envelope's request pipeline.
 */
export const makeCloudflareExecutionStackLayer = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config),
    makeCloudflareHostConfig(config),
    CloudflareCodeExecutorProvider,
    EngineDecoratorNoop,
  );
