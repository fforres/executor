import { describe, expect, it } from "@effect/vitest";

import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";

import type { CloudflareConfig } from "../config";
import { applyDelegatedSubject, principalFromAccessClaims } from "./cloudflare-access";

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
  webBaseUrl: "https://localhost",
  enableDevAuth: false,
};

describe("principalFromAccessClaims", () => {
  it("maps a human identity (email + sub + groups)", () => {
    const p = principalFromAccessClaims(
      { sub: "user-123", email: "person@example.com", name: "Person", groups: ["eng"] },
      config,
    );
    expect(p.accountId).toBe("user-123");
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

const DELEGATOR = "agent-token.access";
const delegating: CloudflareConfig = { ...config, accessDelegationCommonName: DELEGATOR };

// The delegator itself: a service-token principal, exactly as Access presents one.
const delegatorPrincipal = () =>
  principalFromAccessClaims({ common_name: DELEGATOR, type: "app" }, delegating);

describe("applyDelegatedSubject", () => {
  it("passes an ordinary request through untouched", () => {
    const p = principalFromAccessClaims({ sub: "user-123", email: "person@example.com" }, config);
    expect(applyDelegatedSubject(p, config, { subject: null, email: null })).toBe(p);
  });

  it("re-binds the trusted delegator to the named subject", () => {
    const p = applyDelegatedSubject(delegatorPrincipal(), delegating, {
      subject: "alice-access-sub",
      email: "alice@example.com",
    });
    expect(p?.accountId).toBe("alice-access-sub");
    expect(p?.email).toBe("alice@example.com");
    expect(p?.roles).toEqual(["member"]);
  });

  it("mirrors the delegated human's admin standing", () => {
    const p = applyDelegatedSubject(delegatorPrincipal(), delegating, {
      subject: "admin-access-sub",
      email: "ADMIN@example.com",
    });
    expect(p?.roles).toContain("admin");
    expect(p?.orgRole).toBe("admin");
  });

  it("REJECTS a human trying to delegate, rather than ignoring the header", () => {
    const human = principalFromAccessClaims({ sub: "u", email: "person@example.com" }, delegating);
    expect(applyDelegatedSubject(human, delegating, { subject: "alice", email: null })).toBeNull();
  });

  it("REJECTS an admin human trying to delegate", () => {
    const admin = principalFromAccessClaims({ sub: "u", email: "admin@example.com" }, delegating);
    expect(applyDelegatedSubject(admin, delegating, { subject: "alice", email: null })).toBeNull();
  });

  it("REJECTS a service token that is not the configured delegator", () => {
    const other = principalFromAccessClaims({ common_name: "other.access" }, delegating);
    expect(applyDelegatedSubject(other, delegating, { subject: "alice", email: null })).toBeNull();
  });

  it("REJECTS delegation when no delegator is configured", () => {
    const token = principalFromAccessClaims({ common_name: DELEGATOR }, config);
    expect(applyDelegatedSubject(token, config, { subject: "alice", email: null })).toBeNull();
  });

  it("REJECTS a delegator that names an email but no subject", () => {
    const p = applyDelegatedSubject(delegatorPrincipal(), delegating, {
      subject: "   ",
      email: "alice@example.com",
    });
    expect(p).toBeNull();
  });
});
