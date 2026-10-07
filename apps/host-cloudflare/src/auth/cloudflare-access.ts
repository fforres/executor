import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized, type Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";
import { matchApiKey, presentedApiKey } from "./api-keys";

// ---------------------------------------------------------------------------
// Cloudflare Access IdentityProvider — the CF-native swap for self-host's
// Better Auth. Cloudflare Access (Zero Trust) sits IN FRONT of the Worker and
// authenticates the human; it forwards a signed `Cf-Access-Jwt-Assertion` JWT.
// This provider verifies that JWT against the team's public JWKS and maps its
// claims onto the neutral `Principal`. There is no app-level login, no session
// store, no password — the IdP is the gate.
//
// Single-tenant: every verified principal belongs to the one configured org.
// Roles come from the admin allowlist + the Access groups claim.
// ---------------------------------------------------------------------------

/**
 * Normalize an identity value into the key ownership is stored under. Lowercased
 * and trimmed so the same person is one account however their IdP happens to
 * capitalize them; every value that reaches here (email, Access UUID, service
 * token common name) is case-insensitive in its own right.
 */
const identityKey = (value: string): string => value.trim().toLowerCase();

/**
 * Map verified Access JWT claims onto the neutral `Principal`. Pure (no JWT
 * verification) so it is unit-testable. Handles both human identities (email +
 * sub, optional groups) and SERVICE TOKENS — machine/API-key auth via the
 * `CF-Access-Client-Id`/`-Secret` headers — which carry `common_name` (the
 * token's client id) instead of email/sub. Single-tenant: every principal
 * belongs to the one configured org; admin comes from the email allowlist.
 *
 * A human is keyed by EMAIL, not by the Access `sub`. Cloudflare documents `sub`
 * as unique to an email address per account but NOT durable: remove and re-add a
 * user's seat and they come back with a different one, which would orphan every
 * connection they own. The email is the identifier that survives that, and it is
 * also the only one a delegating backend can know about a person (see
 * `applyDelegatedSubject`), so keying on it is what lets a browser session and an
 * agent acting for that same person reach the same rows.
 */
export const principalFromAccessClaims = (
  claims: Record<string, unknown>,
  config: CloudflareConfig,
): Principal => {
  const email = typeof claims.email === "string" ? claims.email : "";
  const sub = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : "";
  const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
  const nameClaim = claims[config.accessNameClaim];
  const groupsClaim = claims[config.accessGroupsClaim];
  const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];
  const isAdmin = email.length > 0 && config.adminEmails.includes(email.toLowerCase());

  return {
    kind: "member",
    accountId: identityKey(email || sub || commonName),
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email,
    name: typeof nameClaim === "string" ? nameClaim : commonName || null,
    avatarUrl: null,
    roles: isAdmin ? ["admin", ...groups] : groups.length > 0 ? groups : ["member"],
    orgRoleModel: "organization",
    orgRole: isAdmin ? "admin" : "member",
  };
};

/** Header naming the subject a trusted delegating caller is acting for. */
export const DELEGATED_SUBJECT_HEADER = "X-Executor-Subject";
/** Header carrying that subject's email, so roles resolve as they would in a browser. */
export const DELEGATED_EMAIL_HEADER = "X-Executor-Subject-Email";

/** The delegation a request asserts, read straight off the headers (both null on
 *  an ordinary request). */
export interface DelegatedIdentity {
  readonly subject: string | null;
  readonly email: string | null;
}

export const readDelegatedIdentity = (request: Request): DelegatedIdentity => ({
  subject: request.headers.get(DELEGATED_SUBJECT_HEADER),
  email: request.headers.get(DELEGATED_EMAIL_HEADER),
});

/**
 * Re-bind a verified principal to the subject a TRUSTED service token says it is
 * acting for. Cloudflare Access authenticates browsers and machines, but has no
 * way to express "this backend is acting for Alice" — a service token's identity
 * is the token. Without this, a headless agent can only ever reach `owner: "org"`
 * rows, because its subject never matches any human's.
 *
 * The subject a delegator sends is that person's EMAIL, the same key a browser
 * session resolves to in `principalFromAccessClaims`. The two must agree or the
 * delegated run silently sees organization rows only.
 *
 * The gate, in order:
 *   - no delegation headers at all → the principal passes through untouched;
 *   - the caller is NOT the one configured delegator → `null`, i.e. REJECT the
 *     request. Silently ignoring the header would let any Access-authenticated
 *     human probe for delegation and learn whether it is enabled;
 *   - a delegator that names no subject → `null`, for the same reason.
 *
 * Only a service token may delegate: a human principal always carries an `email`,
 * so requiring an empty one means a browser session can never delegate even if it
 * somehow learned the delegator's id.
 *
 * Roles MIRROR the delegated human's real standing, so the agent reaches exactly
 * what that person reaches in a browser. Note the one asymmetry: Access `groups`
 * are not available to the delegator, so a delegated principal gets admin from the
 * email allowlist but never group-derived roles.
 *
 * Pure (no request, no IO) so it is unit-testable, like `principalFromAccessClaims`.
 */
export const applyDelegatedSubject = (
  principal: Principal,
  config: CloudflareConfig,
  delegated: DelegatedIdentity,
): Principal | null => {
  const subject = delegated.subject?.trim() ?? "";
  const email = delegated.email?.trim() ?? "";
  if (subject.length === 0 && email.length === 0) return principal;

  const delegator = identityKey(config.accessDelegationCommonName ?? "");
  const mayDelegate =
    delegator.length > 0 && principal.email.length === 0 && principal.accountId === delegator;
  if (!mayDelegate) return null;
  if (subject.length === 0) return null;

  const isAdmin = email.length > 0 && config.adminEmails.includes(email.toLowerCase());
  return {
    ...principal,
    accountId: identityKey(subject),
    email,
    name: email.length > 0 ? email : subject,
    roles: isAdmin ? ["admin"] : ["member"],
    // Restated rather than left to the spread: `Principal` discriminates `orgRole`
    // on `orgRoleModel`, so the spread alone leaves the union open and `orgRole`
    // unassignable. This host only ever builds the "organization" arm.
    orgRoleModel: "organization",
    orgRole: isAdmin ? "admin" : "member",
  };
};

const ACCESS_COOKIE = "CF_Authorization";

const cookieValue = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
};

/**
 * The Access JWT a request carries: the `Cf-Access-Jwt-Assertion` header Access
 * injects on paths it protects, else the `CF_Authorization` cookie it sets for
 * the whole hostname — which is what authenticates the browser UI on paths Access
 * does not front (API and MCP stay public so API keys can reach them).
 */
export const accessTokenFromRequest = (request: Request): string | null =>
  request.headers.get("Cf-Access-Jwt-Assertion") ||
  cookieValue(request.headers.get("cookie"), ACCESS_COOKIE);

/** The principal API keys and the internal entrypoint act as: the admin identified
 *  by `apiKeyPrincipalEmail`, keyed on the email like the same person's browser session. */
export const ownerPrincipal = (config: CloudflareConfig, name: string): Principal => ({
  kind: "member",
  accountId: identityKey(config.apiKeyPrincipalEmail),
  organizationId: config.organizationId,
  organizationName: config.organizationName,
  organizationSlug: config.organizationSlug,
  email: config.apiKeyPrincipalEmail,
  name,
  avatarUrl: null,
  roles: ["admin"],
  orgRoleModel: "organization",
  orgRole: "admin",
});

/**
 * Resolve a request to its verified `Principal`, or `null` when no credential
 * verifies. The single source of truth for "who is this request", shared by the
 * `IdentityProvider` (the API gate) and the MCP auth provider (the `/mcp` gate).
 * Fail-closed: a request is anonymous unless exactly one of these holds.
 *
 *   1. An API key (`Authorization: Bearer exk_...` or `x-api-key`) whose hash is
 *      configured. A key that is presented but wrong is rejected outright — it
 *      never falls through to another credential.
 *   2. A verified Access JWT, from the header or the `CF_Authorization` cookie.
 *   3. Dev auth (local only; `loadConfig` refuses it on a production marker).
 *
 * `jose` caches + rotates the team JWKS, so build the verifier once per config.
 * `options.jwks` swaps the remote team key set (tests).
 */
export const makeAccessVerifier = (
  config: CloudflareConfig,
  options: { readonly jwks?: JWTVerifyGetKey } = {},
) => {
  const issuer = `https://${config.accessTeamDomain}`;
  // Cached, lazily-fetched team signing keys; jose handles rotation + caching.
  // Absent in dev-auth and API-key-only deployments (no Access configured).
  const accessConfigured = config.accessTeamDomain.length > 0 && config.accessAud.length > 0;
  const jwks: JWTVerifyGetKey | null =
    options.jwks ??
    (config.enableDevAuth || !accessConfigured
      ? null
      : createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));

  // Dev/single-user escape hatch: bypass Access entirely, every request is a
  // fixed admin. Only when explicitly enabled (and the instance is otherwise
  // unprotected). Mirrors the local app's single-user model.
  const devPrincipal: Principal = {
    kind: "member",
    accountId: "dev",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: config.adminEmails[0] ?? "dev@local",
    name: "Dev",
    avatarUrl: null,
    roles: ["admin"],
    orgRoleModel: "organization",
    orgRole: "admin",
  };

  const verifyApiKey = (key: string): Effect.Effect<Principal | null> =>
    Effect.promise(() => matchApiKey(key, config.apiKeys)).pipe(
      Effect.map((match) => (match ? ownerPrincipal(config, `API key ${match.label}`) : null)),
    );

  const verifyAccess = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      if (!jwks) return null;
      const token = accessTokenFromRequest(request);
      if (!token) return null;

      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, jwks, { issuer, audience: config.accessAud }),
        catch: () => "invalid access assertion",
      }).pipe(Effect.orElseSucceed(() => null));
      if (!verified) return null;

      const principal = principalFromAccessClaims(
        verified.payload as Record<string, unknown>,
        config,
      );
      // Delegation runs AFTER verification, never instead of it: the caller is
      // always a fully verified Access principal first.
      return applyDelegatedSubject(principal, config, readDelegatedIdentity(request));
    });

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      // Only the `ExecutorInternal` service-binding entrypoint builds a config with
      // this set; it is not read from `env` or the request, so no header or
      // credential presented to the public `fetch` can reach this branch.
      if (config.trustedInternal) return ownerPrincipal(config, "Internal service binding");
      if (config.enableDevAuth) return devPrincipal;
      const key = presentedApiKey(request.headers);
      if (key !== null) return yield* verifyApiKey(key);
      return yield* verifyAccess(request);
    });

  return { verify };
};

export const cloudflareAccessIdentityLayer = (
  config: CloudflareConfig,
): Layer.Layer<IdentityProvider> => {
  const { verify } = makeAccessVerifier(config);
  return Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) =>
        verify(request).pipe(
          Effect.flatMap((principal) =>
            principal ? Effect.succeed(principal) : Effect.fail(new Unauthorized()),
          ),
        ),
    }),
  );
};
