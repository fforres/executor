import { describe, expect, it } from "@effect/vitest";

import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";

import type { CloudflareConfig } from "../config";
import { principalFromAccessClaims } from "./cloudflare-access";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["admin@example.com"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  internalHosts: {},
  webBaseUrl: "https://localhost",
  enableDevAuth: false,
  trustedInternal: false,
  apiKeys: [],
  apiKeyPrincipalEmail: "",
};

describe("principalFromAccessClaims", () => {
  it("maps a human identity (email + sub + groups), keyed on the EMAIL not the sub", () => {
    const p = principalFromAccessClaims(
      { sub: "user-123", email: "person@example.com", name: "Person", groups: ["eng"] },
      config,
    );
    expect(p.accountId).toBe("person@example.com");
    expect(p.email).toBe("person@example.com");
    expect(p.name).toBe("Person");
    expect(p.roles).toEqual(["eng"]);
    expect(p.organizationId).toBe("default");
  });

  it("grants admin when the email is in the allowlist", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "ADMIN@example.com" }, config);
    expect(p.roles).toContain("admin");
    expect(p.orgRoleModel).toBe("organization");
    expect(p.orgRole).toBe("admin");
    expect(orgWriteAccessForPrincipal(p)).toBe("allowed");
  });

  it("survives a seat being removed and re-added, which changes the Access sub", () => {
    // Cloudflare documents `sub` as unique per email per account, but NOT durable:
    // re-adding a user's seat mints a new one. Keying on it would orphan every
    // connection that person owns.
    const before = principalFromAccessClaims({ sub: "sub-1", email: "person@example.com" }, config);
    const after = principalFromAccessClaims({ sub: "sub-2", email: "person@example.com" }, config);
    expect(after.accountId).toBe(before.accountId);
  });

  it("is case-insensitive, so one person is never two accounts", () => {
    const shouty = principalFromAccessClaims({ sub: "u", email: "Person@Example.com" }, config);
    const quiet = principalFromAccessClaims({ sub: "u", email: "person@example.com" }, config);
    expect(shouty.accountId).toBe(quiet.accountId);
  });

  it("falls back to the sub when a human identity carries no email", () => {
    const p = principalFromAccessClaims({ sub: "user-123" }, config);
    expect(p.accountId).toBe("user-123");
  });

  it("gives a SERVICE TOKEN (common_name, no email/sub) a stable identity", () => {
    // Cloudflare Access service-token JWT: common_name set, email/sub absent.
    const p = principalFromAccessClaims({ common_name: "df8a20db.access", type: "app" }, config);
    expect(p.accountId).toBe("df8a20db.access"); // not empty — stable per token
    expect(p.name).toBe("df8a20db.access");
    expect(p.email).toBe("");
    expect(p.roles).toEqual(["member"]); // a token is a member, not an admin
    expect(p.organizationId).toBe("default");
  });

  it("defaults to member when there are no groups and no admin match", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "nobody@other.com" }, config);
    expect(p.roles).toEqual(["member"]);
    expect(p.orgRoleModel).toBe("organization");
    expect(p.orgRole).toBe("member");
    expect(orgWriteAccessForPrincipal(p)).toBe("denied");
  });
});
