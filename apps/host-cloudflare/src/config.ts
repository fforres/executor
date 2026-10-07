import type { D1Database, DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

import { isValidOrgSlug } from "@executor-js/api";
import { missingPublicOriginWarning, resolvePublicOrigin } from "@executor-js/sdk/public-origin";

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
  /**
   * The `common_name` of the ONE Access service token allowed to act on behalf
   * of another subject (see `applyDelegatedSubject`). Unset disables delegation
   * entirely, which is the correct default: an instance with no headless agent
   * in front of it should never accept a delegated subject.
   */
  readonly ACCESS_DELEGATION_COMMON_NAME?: string;
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
  /** See {@link CloudflareEnv.ACCESS_DELEGATION_COMMON_NAME}. Optional so an
   *  instance that never delegates carries no extra configuration. */
  readonly accessDelegationCommonName?: string;
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
export const missingCloudflareAccessVars = (env: CloudflareAccessEnv): readonly string[] => {
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
export const devAuthInProductionError = (env: CloudflareAccessEnv): string | null => {
  if (env.ENABLE_DEV_AUTH !== "true") return null;
  const production =
    (env.ENVIRONMENT ?? "").trim().toLowerCase() === "production" ||
    (env.ACCESS_AUD ?? "").trim().length > 0;
  return production
    ? "ENABLE_DEV_AUTH is set on a production deployment (ACCESS_AUD or ENVIRONMENT=production is set). Refusing to serve requests; unset ENABLE_DEV_AUTH."
    : null;
};

/** The first reason this environment must not serve requests, or null. */
export const cloudflareConfigProblem = (env: CloudflareAccessEnv): string | null => {
  const devAuth = devAuthInProductionError(env);
  if (devAuth) return devAuth;
  const missing = missingCloudflareAccessVars(env);
  return missing.length > 0 ? cloudflareAccessConfigErrorMessage(missing) : null;
};

export const cloudflareAccessConfigErrorMessage = (missingVars: readonly string[]): string =>
  `Cloudflare Access is not configured. Set ${missingVars.join(" and ")} before serving requests.`;

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments — a colliding slug would shadow real routes (notably /api, /mcp,
// and Cloudflare's /cdn-cgi).
const resolveOrgSlug = (value: string | undefined): string => {
  if (!value) return "default";
  if (!isValidOrgSlug(value) && value !== "default") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a colliding org slug would shadow app routes; refuse to boot
    throw new Error(
      `SELF_HOSTED_ORG_SLUG ${JSON.stringify(value)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "mcp")`,
    );
  }
  return value;
};

export const loadConfig = (env: CloudflareConfigEnv): CloudflareConfig => {
  const secretKey = env.EXECUTOR_SECRET_KEY?.trim();
  if (!secretKey || secretKey.length < 16) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the Worker must not boot without the at-rest secret key
    throw new Error(
      "EXECUTOR_SECRET_KEY must be set (wrangler secret put EXECUTOR_SECRET_KEY) — it encrypts stored secrets at rest in D1",
    );
  }
  const devAuthError = devAuthInProductionError(env);
  if (devAuthError) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: dev auth in production is a wide-open instance; refuse to boot
    throw new Error(devAuthError);
  }
  const enableDevAuth = env.ENABLE_DEV_AUTH === "true";
  const accessTeamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const accessAud = (env.ACCESS_AUD ?? "").trim();
  const missingAccessVars = missingCloudflareAccessVars(env);
  if (missingAccessVars.length > 0) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: production must fail closed without a valid Access verifier
    throw new Error(cloudflareAccessConfigErrorMessage(missingAccessVars));
  }
  const apiKeys = parseApiKeyHashes(env.EXECUTOR_API_KEY_HASHES);
  if (typeof apiKeys === "string") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a malformed key list must not silently disable or weaken auth
    throw new Error(apiKeys);
  }
  const apiKeyPrincipalEmail = (env.API_KEY_PRINCIPAL_EMAIL ?? "").trim().toLowerCase();
  if (apiKeys.length > 0 && !apiKeyPrincipalEmail.includes("@")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: API keys need a principal to act as
    throw new Error(
      "API_KEY_PRINCIPAL_EMAIL must be set to an email when EXECUTOR_API_KEY_HASHES is configured",
    );
  }
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
  return {
    accessTeamDomain,
    accessAud,
    accessNameClaim: env.ACCESS_NAME_CLAIM ?? "name",
    accessGroupsClaim: env.ACCESS_GROUPS_CLAIM ?? "groups",
    adminEmails: splitLower(env.ADMIN_EMAILS),
    accessDelegationCommonName: env.ACCESS_DELEGATION_COMMON_NAME?.trim() || undefined,
    organizationId: env.SELF_HOSTED_ORG_ID ?? "default",
    organizationName: env.SELF_HOSTED_ORG_NAME ?? "Default",
    organizationSlug: resolveOrgSlug(env.SELF_HOSTED_ORG_SLUG),
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
    apiKeys,
    apiKeyPrincipalEmail,
  };
};
