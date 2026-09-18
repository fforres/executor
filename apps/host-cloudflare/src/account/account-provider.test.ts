import { describe, expect, it } from "@effect/vitest";

import { principalFromAccessClaims } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";
import { memberRowFromPrincipal } from "./account-provider";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["felipe@skyward.ai", "sergio@skyward.ai"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://localhost",
  enableDevAuth: false,
};

const rowFor = (claims: Record<string, unknown>) =>
  memberRowFromPrincipal(principalFromAccessClaims(claims, config));

describe("memberRowFromPrincipal", () => {
  it("reports an allowlisted human as an active admin", () => {
    const row = rowFor({ sub: "felipe-sub", email: "felipe@skyward.ai" });
    expect(row.role).toBe("admin");
    expect(row.status).toBe("active");
    expect(row.isCurrentUser).toBe(true);
    expect(row.userId).toBe("felipe-sub");
    // These three fields together are exactly what the shell's
    // isTenantAdminMember() requires before it offers the Workspace connection
    // owner (packages/react/src/lib/admin-access.ts). Not imported here: that is
    // a browser package, and this host must not depend on it.
  });

  it("reports the second allowlisted admin too", () => {
    expect(rowFor({ sub: "s", email: "sergio@skyward.ai" }).role).toBe("admin");
  });

  it("is case-insensitive about the allowlist", () => {
    expect(rowFor({ sub: "f", email: "FELIPE@skyward.ai" }).role).toBe("admin");
  });

  it("reports a non-allowlisted teammate as a plain member", () => {
    const row = rowFor({ sub: "o", email: "otro@skyward.ai" });
    expect(row.role).toBe("member");
  });

  it("reports a service token as a plain member", () => {
    expect(rowFor({ common_name: "agent-token.access" }).role).toBe("member");
  });
});
