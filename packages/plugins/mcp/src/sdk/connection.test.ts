import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { createMcpConnector, withDefaultUserAgent } from "./connection";

const endpoint = "https://internal.example/mcp";

describe("MCP remote transport failures", () => {
  it.effect("surfaces TLS verification failures without retrying SSE", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          requests.push(request.url);
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: {
                  code: "SELF_SIGNED_CERT_IN_CHAIN",
                  message: "do-not-leak: internal certificate detail",
                },
              }),
            }),
          );
        }),
      );

      const failure = yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "auto",
        httpClientLayer,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "McpConnectionError",
        transport: "streamable-http",
        failureKind: "tls",
        message:
          "MCP HTTPS connection failed: TLS certificate verification failed. Check the server certificate and Executor's CA trust configuration.",
      });
      expect(failure.message).not.toContain("do-not-leak");
      expect(requests).toEqual([endpoint]);
    }),
  );

  it.effect("reports both attempts when a protocol mismatch falls back to SSE", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          requests.push(`${request.method} ${request.url}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("unsupported MCP transport", { status: 405 }),
            ),
          );
        }),
      );

      const failure = yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "auto",
        httpClientLayer,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "McpConnectionError",
        transport: "auto",
        failureKind: "protocol",
        message: "MCP auto transport failed. Streamable HTTP: HTTP 405. SSE fallback: HTTP 405.",
      });
      expect(requests.length).toBeGreaterThanOrEqual(2);
    }),
  );
});

describe("MCP remote transport User-Agent", () => {
  // The unit tests below cover the merge rule, but only this one proves the
  // header survives the SDK's requestInit and reaches the wire — it is the
  // test that fails if the default is computed and then dropped.
  it.effect("sends the default User-Agent on the wire", () =>
    Effect.gen(function* () {
      const seen: Array<Record<string, string>> = [];
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          seen.push(request.headers);
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: { code: "ECONNREFUSED", message: "stop here" },
              }),
            }),
          );
        }),
      );

      yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "streamable-http",
        httpClientLayer,
      }).pipe(Effect.flip);

      expect(seen[0]?.["user-agent"]).toBe("skywardai-ua");
    }),
  );
});

describe("withDefaultUserAgent", () => {
  it("adds a User-Agent when none is configured", () => {
    // Workers send none, and a Vercel-fronted MCP edge answers a UA-less
    // request with 403 before it ever evaluates the credential.
    expect(withDefaultUserAgent({})).toEqual({ "User-Agent": "skywardai-ua" });
  });

  it("keeps existing headers alongside it", () => {
    expect(withDefaultUserAgent({ Authorization: "api-key abc" })).toEqual({
      Authorization: "api-key abc",
      "User-Agent": "skywardai-ua",
    });
  });

  it("never overrides an explicitly configured User-Agent", () => {
    expect(withDefaultUserAgent({ "User-Agent": "mine/2.0" })).toEqual({
      "User-Agent": "mine/2.0",
    });
  });

  it("matches the configured header case-insensitively, since HTTP names are", () => {
    expect(withDefaultUserAgent({ "user-agent": "mine/2.0" })).toEqual({
      "user-agent": "mine/2.0",
    });
  });

  it("does not mutate the caller's headers", () => {
    const original = { Authorization: "api-key abc" };
    withDefaultUserAgent(original);
    expect(original).toEqual({ Authorization: "api-key abc" });
  });
});
