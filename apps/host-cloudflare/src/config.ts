import type { D1Database, DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

import { isValidOrgSlug } from "@executor-js/api";
import { missingPublicOriginWarning, resolvePublicOrigin } from "@executor-js/sdk/public-origin";

import { CLEF_FLASH_MODEL, type ClefAiBinding, type ClefConfig } from "@executor-js/execution";
import { parseApiKeyHashes, type ApiKeyHash } from "./auth/api-keys";

let warnedNoCloudflareOrigin = false;

// ---------------------------------------------------------------------------
// Cloudflare host config. Unlike self-host (process.env + a data dir), a Worker
// receives its bindings + vars per request as `env`, so config is derived from
// that object — there is no process.env, no filesystem, no boot-time secret
// generation. Identity comes entirely from Cloudflare Access in front of the
// Worker; the only real secret is the at-rest secret-encryption key.
// ---------------------------------------------------------------------------

export const CLOUDFLARE_NAMESPACE = "executor_cloudflare";
export const CLOUDFLARE_SCHEMA_VERSION = "1.0.0";

export interface CloudflareEnv {
  /** D1 database binding — the app's SQLite store. */
  readonly DB: D1Database;
  /** R2 bucket binding — holds values too large for a D1 row (~1-2MB cap). */
  readonly BLOBS?: R2Bucket;
  /** Static assets binding (wrangler.jsonc `assets.binding`). The MCP session
   *  DO fetches the built MCP-Apps shell document through it — a deployed
   *  Worker has no filesystem to read the shell from. */
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  /** MCP session Durable Object namespace — one addressable isolate per MCP
   *  session (the DO id IS the session id), so a session survives across the
   *  Worker's stateless isolates. */
  readonly MCP_SESSION: DurableObjectNamespace;
  readonly MCP_EXECUTION_OWNER?: DurableObjectNamespace;
  /** Zero Trust team domain, e.g. `your-team.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag (the JWT audience to verify). */
  readonly ACCESS_AUD?: string;
  /** Claim holding the display name (default `name`). */
  readonly ACCESS_NAME_CLAIM?: string;
  /** Claim holding the user's groups (default `groups`). */
  readonly ACCESS_GROUPS_CLAIM?: string;
  /** Comma-separated emails granted the admin role. */
  readonly ADMIN_EMAILS?: string;
  /** The single organization id/name every authenticated user belongs to. */
  readonly SELF_HOSTED_ORG_ID?: string;
  readonly SELF_HOSTED_ORG_NAME?: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly SELF_HOSTED_ORG_SLUG?: string;
  /** At-rest secret-encryption key (a `wrangler secret`, NOT a var). */
  readonly EXECUTOR_SECRET_KEY?: string;
  readonly ALLOW_LOCAL_NETWORK?: string;
  readonly VITE_PUBLIC_SITE_URL?: string;
  /**
   * Dev/single-user escape hatch: when "true", skip Cloudflare Access entirely
   * and treat every request as a fixed admin. For local `wrangler dev` and
   * unattended validation only — NEVER set on a deployment that isn't already
   * behind Access, or the instance is wide open.
   */
  readonly ENABLE_DEV_AUTH?: string;
  /**
   * Workers AI binding (wrangler `ai`). Tool search ranks with Cloudflare Clef
   * through it; absent, search stays lexical and says it was not ranked.
   */
  readonly AI?: ClefAiBinding;
  /** AI Gateway id the Clef calls are logged through (optional, for logs). */
  readonly CLEF_GATEWAY_ID?: string;
  /** Clef model: `@cf/cloudflare/clef-flash` (default) or `@cf/cloudflare/clef`. */
  readonly CLEF_MODEL?: string;
  /** Marks a deployed environment. `production` makes `ENABLE_DEV_AUTH` a boot error. */
  readonly ENVIRONMENT?: string;
  /**
   * Comma-separated SHA-256 hashes (hex) of the API keys accepted as
   * `Authorization: Bearer <key>` or `x-api-key`, each optionally written
   * `label:hash`. Only hashes are stored — mint one with
   * `bun run apps/host-cloudflare/scripts/api-key.ts create`. A `wrangler secret`.
   */
  readonly EXECUTOR_API_KEY_HASHES?: string;
  /**
   * Email of the admin principal every API key acts as. It keys the same account a
   * browser session for that email resolves to, so personal connections are shared.
   * Required whenever `EXECUTOR_API_KEY_HASHES` is set.
   */
  readonly API_KEY_PRINCIPAL_EMAIL?: string;
}

export interface CloudflareConfig {
  readonly accessTeamDomain: string;
  readonly accessAud: string;
  readonly accessNameClaim: string;
  readonly accessGroupsClaim: string;
  readonly adminEmails: readonly string[];
  readonly organizationId: string;
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly organizationSlug: string;
  readonly secretKey: string;
  readonly allowLocalNetwork: boolean;
  /** Explicit web base URL (`VITE_PUBLIC_SITE_URL`). Unset on a Worker with no
   *  static URL — the per-request origin is used instead (see RequestWebOrigin). */
  readonly webBaseUrl?: string;
  readonly enableDevAuth: boolean;
  /**
   * True ONLY for the config the `ExecutorInternal` service-binding entrypoint
   * builds (`loadConfig(env, { internal: true })`). Every request it serves acts
   * as the single user without credentials. It is never derived from `env` or
   * from a request, so the public `fetch` can never be in this mode.
   */
  readonly trustedInternal: boolean;
  /** Present only when the Workers AI binding is bound; absent leaves search lexical. */
  readonly clef?: ClefConfig;
  /** Accepted API keys (hash only). Empty disables API-key auth. */
  readonly apiKeys: readonly ApiKeyHash[];
  /** The principal every API key acts as. Set whenever `apiKeys` is non-empty. */
  readonly apiKeyPrincipalEmail: string;
}

type CloudflareConfigEnv = Omit<
  CloudflareEnv,
  "DB" | "BLOBS" | "ASSETS" | "MCP_SESSION" | "MCP_EXECUTION_OWNER"
>;

type CloudflareAccessEnv = Pick<
  CloudflareConfigEnv,
  | "ACCESS_TEAM_DOMAIN"
  | "ACCESS_AUD"
  | "ENABLE_DEV_AUTH"
  | "ENVIRONMENT"
  | "EXECUTOR_API_KEY_HASHES"
  | "API_KEY_PRINCIPAL_EMAIL"
>;

const splitLower = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

const normalizeAccessTeamDomain = (value: string | undefined): string =>
  (value ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

const hasApiKeys = (env: CloudflareAccessEnv): boolean =>
  (env.EXECUTOR_API_KEY_HASHES ?? "").trim().length > 0;

/**
 * Names the Access variables still missing. With API keys configured, leaving
 * both Access variables unset is a valid API-key-only deployment (the JWT path is
 * then disabled); setting only one of them is always an error.
 */
const missingAccessVars = (env: CloudflareAccessEnv): readonly string[] => {
  if (env.ENABLE_DEV_AUTH === "true") return [];
  const accessTeamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const accessAud = (env.ACCESS_AUD ?? "").trim();
  const teamDomainMissing =
    accessTeamDomain.length === 0 ||
    accessTeamDomain.toLowerCase() === "your-team.cloudflareaccess.com";
  const audMissing = accessAud.length === 0;
  if (hasApiKeys(env) && accessTeamDomain.length === 0 && audMissing) return [];
  return [
    ...(teamDomainMissing ? ["ACCESS_TEAM_DOMAIN"] : []),
    ...(audMissing ? ["ACCESS_AUD"] : []),
  ];
};

/**
 * Dev auth makes every request a fixed admin, so it must never survive into a
 * deployment: an Access audience or `ENVIRONMENT=production` marks one.
 */
const devAuthInProduction = (env: CloudflareAccessEnv): boolean =>
  env.ENABLE_DEV_AUTH === "true" &&
  ((env.ENVIRONMENT ?? "").trim().toLowerCase() === "production" ||
    (env.ACCESS_AUD ?? "").trim().length > 0);

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments — a colliding slug would shadow real routes (notably /api, /mcp,
// and Cloudflare's /cdn-cgi).
const orgSlugProblem = (value: string | undefined): string | null =>
  value && !isValidOrgSlug(value) && value !== "default"
    ? `SELF_HOSTED_ORG_SLUG ${JSON.stringify(value)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "mcp")`
    : null;

const resolveClef = (env: CloudflareConfigEnv): ClefConfig | undefined => {
  if (!env.AI) return undefined;
  const gatewayId = env.CLEF_GATEWAY_ID?.trim();
  return {
    ai: env.AI,
    model: env.CLEF_MODEL?.trim() || CLEF_FLASH_MODEL,
    ...(gatewayId ? { gatewayId } : {}),
  };
};

export interface LoadConfigOptions {
  /** Build the trusted config for the service-binding entrypoint (see
   *  {@link CloudflareConfig.trustedInternal}). Needs `API_KEY_PRINCIPAL_EMAIL`. */
  readonly internal?: boolean;
}

export type LoadConfigResult =
  | { readonly ok: true; readonly config: CloudflareConfig }
  | { readonly ok: false; readonly message: string };

/**
 * The single validator: every reason this environment must not serve requests is
 * decided here, and nowhere else, as a message. `loadConfig` throws it; a caller
 * that answers with it (the Worker's 503) reads the result.
 */
export const loadConfigResult = (
  env: CloudflareConfigEnv,
  options: LoadConfigOptions = {},
): LoadConfigResult => {
  const refuse = (message: string): LoadConfigResult => ({ ok: false, message });
  const secretKey = env.EXECUTOR_SECRET_KEY?.trim();
  if (!secretKey || secretKey.length < 16) {
    return refuse(
      "EXECUTOR_SECRET_KEY must be set (wrangler secret put EXECUTOR_SECRET_KEY) — it encrypts stored secrets at rest in D1",
    );
  }
  if (devAuthInProduction(env)) {
    return refuse(
      "ENABLE_DEV_AUTH is set on a production deployment (ACCESS_AUD or ENVIRONMENT=production is set). Refusing to serve requests; unset ENABLE_DEV_AUTH.",
    );
  }
  const enableDevAuth = env.ENABLE_DEV_AUTH === "true";
  const accessTeamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const accessAud = (env.ACCESS_AUD ?? "").trim();
  const internal = options.internal === true;
  const missing = internal ? [] : missingAccessVars(env);
  if (missing.length > 0) {
    return refuse(
      `Cloudflare Access is not configured. Set ${missing.join(" and ")} before serving requests.`,
    );
  }
  const apiKeys = parseApiKeyHashes(env.EXECUTOR_API_KEY_HASHES);
  if (typeof apiKeys === "string") return refuse(apiKeys);
  const apiKeyPrincipalEmail = (env.API_KEY_PRINCIPAL_EMAIL ?? "").trim().toLowerCase();
  if ((apiKeys.length > 0 || internal) && !apiKeyPrincipalEmail.includes("@")) {
    return refuse(
      "API_KEY_PRINCIPAL_EMAIL must be set to the owner's email when EXECUTOR_API_KEY_HASHES is configured or the internal service-binding entrypoint is used",
    );
  }
  const slugProblem = orgSlugProblem(env.SELF_HOSTED_ORG_SLUG);
  if (slugProblem !== null) return refuse(slugProblem);
  const webBaseUrl = resolvePublicOrigin({ explicit: env.VITE_PUBLIC_SITE_URL, env: {} });
  if (!webBaseUrl && !enableDevAuth && !warnedNoCloudflareOrigin) {
    warnedNoCloudflareOrigin = true;
    console.warn(
      missingPublicOriginWarning({
        varName: "VITE_PUBLIC_SITE_URL",
        fallback: "the per-request origin",
      }),
    );
  }
  const config: CloudflareConfig = {
    accessTeamDomain,
    accessAud,
    accessNameClaim: env.ACCESS_NAME_CLAIM ?? "name",
    accessGroupsClaim: env.ACCESS_GROUPS_CLAIM ?? "groups",
    adminEmails: splitLower(env.ADMIN_EMAILS),
    organizationId: env.SELF_HOSTED_ORG_ID ?? "default",
    organizationName: env.SELF_HOSTED_ORG_NAME ?? "Default",
    organizationSlug: env.SELF_HOSTED_ORG_SLUG || "default",
    secretKey,
    allowLocalNetwork: env.ALLOW_LOCAL_NETWORK === "true",
    // Pinned origin via the shared resolver. A Worker receives no PaaS platform
    // vars (env: {} — there is nothing to detect), so only the explicit
    // VITE_PUBLIC_SITE_URL applies; when it's unset we leave webBaseUrl undefined
    // and let the per-request origin drive it (request.url — Cloudflare-set, not
    // spoofable via Host). Warn once on a real deployment so the operator pins it,
    // mirroring self-host (gated on enableDevAuth = local `wrangler dev`).
    webBaseUrl,
    enableDevAuth,
    clef: resolveClef(env),
    trustedInternal: internal,
    apiKeys,
    apiKeyPrincipalEmail,
  };
  return { ok: true, config };
};

/** {@link loadConfigResult}, refusing with an `Error` carrying its message. */
export const loadConfig = (
  env: CloudflareConfigEnv,
  options: LoadConfigOptions = {},
): CloudflareConfig => {
  const result = loadConfigResult(env, options);
  if (result.ok) return result.config;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the Worker must not boot with an unsafe or incomplete configuration
  throw new Error(result.message);
};
