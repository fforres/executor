import { Effect } from "effect";

import { sha256Hex } from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// API keys for non-browser callers (agents, MCP clients, other services). A key
// is a high-entropy random token with a recognizable prefix; the Worker stores
// only its SHA-256 hash, so a leaked config never yields a usable credential.
// Because the keys are 256-bit random values, a plain unsalted hash is enough
// (there is nothing to brute-force); the compare is still constant-time.
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX = "exk_";

export interface ApiKeyHash {
  readonly label: string;
  /** Lowercase hex SHA-256 of the full key, prefix included. */
  readonly hash: string;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const hashApiKey = (key: string): Promise<string> => Effect.runPromise(sha256Hex(key));

/** Mint a new key: 256 bits of randomness behind the `exk_` prefix. */
export const generateApiKey = (): string =>
  `${API_KEY_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

/**
 * Parse `EXECUTOR_API_KEY_HASHES`: comma-separated `hash` or `label:hash`
 * entries. Returns the entries, or an error message string when any entry is
 * malformed, so a typo can never silently drop a key (or accept a weak one).
 */
export const parseApiKeyHashes = (value: string | undefined): readonly ApiKeyHash[] | string => {
  const entries = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const parsed: ApiKeyHash[] = [];
  for (const [index, entry] of entries.entries()) {
    const separator = entry.lastIndexOf(":");
    const label = separator === -1 ? `key-${index + 1}` : entry.slice(0, separator);
    const hash = (separator === -1 ? entry : entry.slice(separator + 1)).toLowerCase();
    if (!HEX_SHA256.test(hash)) {
      return `EXECUTOR_API_KEY_HASHES entry ${index + 1} is not a SHA-256 hash (expected 64 hex characters, optionally as label:hash)`;
    }
    if (!LABEL.test(label)) {
      return `EXECUTOR_API_KEY_HASHES entry ${index + 1} has an invalid label (use 1-64 of A-Z a-z 0-9 . _ -)`;
    }
    parsed.push({ label, hash });
  }
  return parsed;
};

/** The key a request presents (`Authorization: Bearer` or `x-api-key`), if it looks like one. */
export const presentedApiKey = (headers: Headers): string | null => {
  const authorization = headers.get("authorization");
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  const candidate = bearer?.startsWith(API_KEY_PREFIX) ? bearer : headers.get("x-api-key")?.trim();
  return candidate && candidate.startsWith(API_KEY_PREFIX) ? candidate : null;
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
};

/** The configured key whose hash matches `key`, comparing against every entry. */
export const matchApiKey = async (
  key: string,
  configured: readonly ApiKeyHash[],
): Promise<ApiKeyHash | null> => {
  const hash = await hashApiKey(key);
  let match: ApiKeyHash | null = null;
  for (const candidate of configured) {
    if (constantTimeEqual(hash, candidate.hash)) match = candidate;
  }
  return match;
};
