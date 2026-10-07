import { describe, expect, it } from "@effect/vitest";

import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  matchApiKey,
  parseApiKeyHashes,
  presentedApiKey,
} from "./api-keys";

describe("generateApiKey", () => {
  it("mints distinct, prefixed, high-entropy keys", () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(first).toMatch(/^exk_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });
});

describe("hashApiKey", () => {
  it("is the lowercase hex SHA-256 of the key", async () => {
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseApiKeyHashes", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  it("accepts bare hashes and label:hash entries", () => {
    expect(parseApiKeyHashes(` ${hashA}, posse:${hashB.toUpperCase()} ,`)).toEqual([
      { label: "key-1", hash: hashA },
      { label: "posse", hash: hashB },
    ]);
  });

  it("is empty for an unset value", () => {
    expect(parseApiKeyHashes(undefined)).toEqual([]);
  });

  it("rejects an entry that is not a SHA-256 hash instead of dropping it", () => {
    expect(parseApiKeyHashes(`${hashA},not-a-hash`)).toMatch(/entry 2 is not a SHA-256 hash/);
  });

  it("rejects an invalid label", () => {
    expect(parseApiKeyHashes(`bad label:${hashA}`)).toMatch(/invalid label/);
  });
});

describe("presentedApiKey", () => {
  it("reads a bearer token and the x-api-key header", () => {
    expect(presentedApiKey(new Headers({ authorization: "Bearer exk_abc" }))).toBe("exk_abc");
    expect(presentedApiKey(new Headers({ "x-api-key": "exk_def" }))).toBe("exk_def");
  });

  it("ignores credentials that are not API keys", () => {
    expect(presentedApiKey(new Headers({ authorization: "Bearer eyJhbGciOi" }))).toBeNull();
    expect(presentedApiKey(new Headers({ authorization: "Basic exk_abc" }))).toBeNull();
    expect(presentedApiKey(new Headers())).toBeNull();
  });
});

describe("matchApiKey", () => {
  it("matches the configured hash and returns its label", async () => {
    const key = generateApiKey();
    const configured = [
      { label: "other", hash: "0".repeat(64) },
      { label: "posse", hash: await hashApiKey(key) },
    ];
    expect(await matchApiKey(key, configured)).toEqual({
      label: "posse",
      hash: configured[1]!.hash,
    });
  });

  it("rejects a key whose hash is not configured", async () => {
    expect(
      await matchApiKey(generateApiKey(), [{ label: "posse", hash: "0".repeat(64) }]),
    ).toBeNull();
  });
});
