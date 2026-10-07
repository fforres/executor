import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { McpAuthProvider } from "@executor-js/host-mcp";

import { cloudflareAccessMcpAuth } from "../mcp/auth";
import { loadConfig, type CloudflareConfig } from "../config";
import { generateApiKey, hashApiKey } from "./api-keys";
import { makeAccessVerifier } from "./cloudflare-access";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag";

const signer = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(signer.publicKey)), kid: "k1", alg: "RS256" };
const jwks = createLocalJWKSet({ keys: [publicJwk] });

const signAccessJwt = (claims: Record<string, unknown>, audience = AUD) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(signer.privateKey);

const apiKey = generateApiKey();

const config: CloudflareConfig = {
  accessTeamDomain: TEAM,
  accessAud: AUD,
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["owner@example.com"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  enableDevAuth: false,
  apiKeys: [{ label: "posse", hash: await hashApiKey(apiKey) }],
  apiKeyPrincipalEmail: "owner@example.com",
};

const request = (headers: Record<string, string> = {}) =>
  new Request("https://executor.example.com/api/tools/search", { headers });

const verify = (headers: Record<string, string> = {}, overrides: Partial<CloudflareConfig> = {}) =>
  Effect.runPromise(
    makeAccessVerifier({ ...config, ...overrides }, { jwks }).verify(request(headers)),
  );

describe("composite auth: API keys", () => {
  it("accepts a valid key as a bearer token and acts as the configured admin", async () => {
    const principal = await verify({ authorization: `Bearer ${apiKey}` });
    expect(principal).toMatchObject({
      accountId: "owner@example.com",
      email: "owner@example.com",
      orgRole: "admin",
      roles: ["admin"],
    });
  });

  it("accepts a valid key in x-api-key", async () => {
    expect((await verify({ "x-api-key": apiKey }))?.accountId).toBe("owner@example.com");
  });

  it("resolves to the same account as the browser session for that email", async () => {
    const viaKey = await verify({ authorization: `Bearer ${apiKey}` });
    const viaBrowser = await verify({
      "cf-access-jwt-assertion": await signAccessJwt({ email: "Owner@Example.com", sub: "s-1" }),
    });
    expect(viaKey?.accountId).toBe(viaBrowser?.accountId);
  });

  it("rejects a wrong key", async () => {
    expect(await verify({ authorization: `Bearer ${generateApiKey()}` })).toBeNull();
  });

  it("does not fall back to a valid Access cookie when the presented key is wrong", async () => {
    const jwt = await signAccessJwt({ email: "owner@example.com" });
    expect(
      await verify({
        authorization: `Bearer ${generateApiKey()}`,
        cookie: `CF_Authorization=${jwt}`,
      }),
    ).toBeNull();
  });

  it("rejects every key when none are configured", async () => {
    expect(await verify({ authorization: `Bearer ${apiKey}` }, { apiKeys: [] })).toBeNull();
  });
});

describe("composite auth: unauthenticated and Access", () => {
  it("rejects a request with no credentials", async () => {
    expect(await verify()).toBeNull();
  });

  it("accepts an Access JWT in the Cf-Access-Jwt-Assertion header", async () => {
    const principal = await verify({
      "cf-access-jwt-assertion": await signAccessJwt({ email: "someone@example.com" }),
    });
    expect(principal?.accountId).toBe("someone@example.com");
    expect(principal?.orgRole).toBe("member");
  });

  it("accepts an Access JWT in the CF_Authorization cookie", async () => {
    const jwt = await signAccessJwt({ email: "owner@example.com" });
    const principal = await verify({ cookie: `theme=dark; CF_Authorization=${jwt}; other=1` });
    expect(principal).toMatchObject({ accountId: "owner@example.com", orgRole: "admin" });
  });

  it("rejects an Access JWT minted for another audience", async () => {
    const jwt = await signAccessJwt({ email: "owner@example.com" }, "someone-elses-aud");
    expect(await verify({ cookie: `CF_Authorization=${jwt}` })).toBeNull();
  });

  it("rejects a malformed Access cookie", async () => {
    expect(await verify({ cookie: "CF_Authorization=not-a-jwt" })).toBeNull();
  });
});

describe("composite auth: MCP gate", () => {
  const authenticate = (headers: Record<string, string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* McpAuthProvider;
        return yield* auth.authenticate(
          new Request("https://executor.example.com/mcp", { method: "POST", headers }),
        );
      }).pipe(Effect.provide(cloudflareAccessMcpAuth(config))),
    );

  it("authenticates /mcp with an API key", async () => {
    const outcome = await authenticate({ authorization: `Bearer ${apiKey}` });
    expect(Predicate.isTagged(outcome, "Authenticated")).toBe(true);
  });

  it("answers 401 to /mcp without credentials", async () => {
    const outcome = await authenticate({});
    expect(Predicate.isTagged(outcome, "Unauthorized")).toBe(true);
  });
});

describe("dev auth in production", () => {
  const base = {
    EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
    VITE_PUBLIC_SITE_URL: "https://executor.example.com",
    ENABLE_DEV_AUTH: "true",
  };

  it("is allowed locally", () => {
    expect(loadConfig(base).enableDevAuth).toBe(true);
  });

  it("is refused when ACCESS_AUD is set", () => {
    expect(() => loadConfig({ ...base, ACCESS_AUD: "aud-tag" })).toThrowError(
      /ENABLE_DEV_AUTH is set on a production deployment/,
    );
  });

  it("is refused when ENVIRONMENT=production", () => {
    expect(() => loadConfig({ ...base, ENVIRONMENT: "production" })).toThrowError(
      /ENABLE_DEV_AUTH is set on a production deployment/,
    );
  });
});
