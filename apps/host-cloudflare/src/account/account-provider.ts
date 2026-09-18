import { Effect, Layer } from "effect";

import {
  AccountProvider,
  accountProviderMiddlewareLayer,
  type AccountHeaders,
  type Principal,
} from "@executor-js/api/server";
import { AccountError, AccountUnauthorized } from "@executor-js/api";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";

// ---------------------------------------------------------------------------
// Cloudflare AccountProvider — backs the shared `/account/*` surface the
// multiplayer shell reads. Cloudflare Access is the identity, so `me` just
// reflects the Access principal (the same `makeAccessVerifier` the API gate
// uses), reading the `Cf-Access-Jwt-Assertion` header off the request.
//
// Single-tenant + Access-managed: members, roles, and API keys live in
// Cloudflare Access, NOT in the app. The shell hides the API-keys footer and
// shows no members page, so those methods are never reached from the UI; they
// return empty (reads) or a clear "managed by Cloudflare Access" error (writes)
// to satisfy the provider shape.
//
// `listMembers` is the ONE exception, and it is load-bearing. The console
// carries no role on the session (`/account/me` returns a user and an
// organization, never a role), so the shell derives "am I an admin" by finding
// the `isCurrentUser` row in this list and reading its role. Returning an empty
// list therefore made EVERY Access user a non-admin in the UI — which silently
// removed the Workspace (`owner: "org"`) choice from the connection-create flow,
// leaving personal connections as the only thing anyone could make, however
// `ADMIN_EMAILS` was set. So we project the Access principal into a single
// member row. There is no directory to enumerate here (Access owns membership),
// so the list is exactly one row: whoever is asking.
// ---------------------------------------------------------------------------

const NOT_IN_APP = "Managed by Cloudflare Access, not in the app.";

/**
 * Project an Access principal into the ONE member row this host reports.
 *
 * `role` mirrors the Access-derived org role (`ADMIN_EMAILS` plus the groups
 * claim), so "admin" in the console means admin at the server gate too, instead
 * of the two disagreeing. `status` is always `"active"`: Access has no pending
 * state — a principal either passed the Access policy or never reached us.
 *
 * Pure (no headers, no IO) so it is unit-testable, like
 * `principalFromAccessClaims` in ../auth/cloudflare-access.
 */
export const memberRowFromPrincipal = (principal: Principal) => ({
  id: principal.accountId,
  userId: principal.accountId,
  email: principal.email,
  name: principal.name,
  avatarUrl: principal.avatarUrl,
  role: principal.orgRole === "admin" ? "admin" : "member",
  status: "active",
  lastActiveAt: null,
  isCurrentUser: true,
});

export const cloudflareAccountProvider = (
  config: CloudflareConfig,
): Layer.Layer<AccountProvider> => {
  const { verify } = makeAccessVerifier(config);

  // The provider gets raw headers; rebuild a minimal Request so `verify` can
  // read the Access assertion header (and honor the dev-auth bypass).
  const principalFrom = (headers: AccountHeaders) =>
    verify(new Request("https://internal.local/", { headers: new Headers(headers) }));

  const forbiddenWrite = Effect.fail(new AccountError({ message: NOT_IN_APP }));

  return Layer.succeed(AccountProvider)({
    me: (headers) =>
      principalFrom(headers).pipe(
        Effect.flatMap((principal) =>
          principal
            ? Effect.succeed({
                user: {
                  id: principal.accountId,
                  email: principal.email,
                  name: principal.name,
                  avatarUrl: principal.avatarUrl,
                },
                organization: {
                  id: principal.organizationId,
                  name: principal.organizationName,
                  slug: config.organizationSlug,
                },
              })
            : Effect.fail(new AccountUnauthorized()),
        ),
      ),
    listApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createApiKey: () => forbiddenWrite,
    revokeApiKey: () => forbiddenWrite,
    // Org-owned keys are a WorkOS concept; Access-managed instances have no
    // credential store of their own to mint one from.
    listOrgApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createOrgApiKey: () => forbiddenWrite,
    revokeOrgApiKey: () => forbiddenWrite,
    listMembers: (headers) =>
      principalFrom(headers).pipe(
        Effect.map((principal) =>
          principal ? { members: [memberRowFromPrincipal(principal)] } : { members: [] },
        ),
      ),
    listRoles: () => Effect.succeed({ roles: [] }),
    inviteMember: () => forbiddenWrite,
    removeMember: () => forbiddenWrite,
    updateMemberRole: () => forbiddenWrite,
    updateOrgName: () => forbiddenWrite,
  });
};

/** The per-request `AccountProvider` middleware (mounted under `/api`). */
export const cloudflareAccountMiddleware = (config: CloudflareConfig) =>
  accountProviderMiddlewareLayer(cloudflareAccountProvider(config));
