import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { parse } from "jsonc-parser";

import { loadConfig } from "./config";

type ConfigEnv = Parameters<typeof loadConfig>[0];

const makeEnv = (overrides: Partial<ConfigEnv> = {}): ConfigEnv => ({
  EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
  VITE_PUBLIC_SITE_URL: "https://executor.example.com",
  ...overrides,
});

describe("loadConfig", () => {
  it("rejects missing Cloudflare Access configuration outside local development", () => {
    expect(() => loadConfig(makeEnv())).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD before serving requests.",
    );
  });

  it("rejects the repository's former team-domain placeholder", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
        }),
      ),
    ).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN before serving requests.",
    );
  });

  it("allows local development to bypass Cloudflare Access", () => {
    expect(loadConfig(makeEnv({ ENABLE_DEV_AUTH: "true" }))).toMatchObject({
      accessTeamDomain: "",
      accessAud: "",
      enableDevAuth: true,
    });
  });

  it("normalises configured Access values without requiring an administrator", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
          ACCESS_AUD: " aud-tag ",
        }),
      ),
    ).toMatchObject({
      accessTeamDomain: "Team.cloudflareaccess.com",
      accessAud: "aud-tag",
      adminEmails: [],
      enableDevAuth: false,
    });
  });
});

describe("loadConfig API keys", () => {
  const hash = "a".repeat(64);

  it("allows an API-key-only deployment with Access unset", () => {
    expect(
      loadConfig(
        makeEnv({
          EXECUTOR_API_KEY_HASHES: `posse:${hash}`,
          API_KEY_PRINCIPAL_EMAIL: "Me@Example.com",
        }),
      ),
    ).toMatchObject({
      apiKeys: [{ label: "posse", hash }],
      apiKeyPrincipalEmail: "me@example.com",
    });
  });

  it("still rejects a half-configured Access setup when keys are present", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          EXECUTOR_API_KEY_HASHES: hash,
          API_KEY_PRINCIPAL_EMAIL: "me@example.com",
          ACCESS_AUD: "aud-tag",
        }),
      ),
    ).toThrowError("Set ACCESS_TEAM_DOMAIN before serving requests");
  });

  it("requires a principal email for the keys", () => {
    expect(() => loadConfig(makeEnv({ EXECUTOR_API_KEY_HASHES: hash }))).toThrowError(
      "API_KEY_PRINCIPAL_EMAIL must be set",
    );
  });

  it("rejects a malformed hash list", () => {
    expect(() =>
      loadConfig(
        makeEnv({ EXECUTOR_API_KEY_HASHES: "nope", API_KEY_PRINCIPAL_EMAIL: "me@example.com" }),
      ),
    ).toThrowError("not a SHA-256 hash");
  });
});

describe("Cloudflare deployment configuration", () => {
  it("preserves operator-managed Access variables across deploys", () => {
    const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      readonly keep_vars?: boolean;
      readonly vars?: Readonly<Record<string, unknown>>;
    };

    expect(config.keep_vars).toBe(true);
    expect(config.vars).not.toHaveProperty("ACCESS_TEAM_DOMAIN");
    expect(config.vars).not.toHaveProperty("ACCESS_AUD");
    expect(config.vars).not.toHaveProperty("ADMIN_EMAILS");
    expect(config.vars).toHaveProperty("ENABLE_DEV_AUTH", "false");
  });
});
