import { Effect } from "effect";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";
import { INVOKE_HTTP_STATUS, type ToolsService } from "./service";

// ---------------------------------------------------------------------------
// REST over the tool service: `POST /api/tools/search`, `GET|POST
// /api/tools/overview` and `POST /api/tools/invoke`. The caller is authenticated
// by the composite auth (API key or Access) and acts as that principal; the
// bodies are the passthrough input schemas, validated by the service.
// ---------------------------------------------------------------------------

const SEARCH_PATH = "/api/tools/search";
const OVERVIEW_PATH = "/api/tools/overview";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const readJson = (request: Request): Effect.Effect<unknown> =>
  Effect.tryPromise({ try: () => request.json(), catch: () => null }).pipe(
    Effect.orElseSucceed(() => null),
  );

const isInvalid = (value: unknown): value is { readonly status: "invalid_arguments" } =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  value.status === "invalid_arguments";

export const makeCloudflareToolsHandler = (
  config: CloudflareConfig,
  service: ToolsService,
): ((request: Request) => Promise<Response>) => {
  const { verify } = makeAccessVerifier(config);

  return (request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const principal = yield* verify(request);
        if (!principal) return json({ error: "Unauthorized" }, 401);
        const { pathname, origin } = new URL(request.url);
        if (pathname === OVERVIEW_PATH) {
          if (request.method !== "GET" && request.method !== "POST") {
            return json({ error: "Method not allowed" }, 405);
          }
          return json(yield* Effect.promise(() => service.overview(principal, origin)));
        }
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const body = yield* readJson(request);
        if (pathname === SEARCH_PATH) {
          const result = yield* Effect.promise(() => service.search(principal, body, origin));
          return json(result, isInvalid(result) ? 400 : 200);
        }
        const result = yield* Effect.promise(() => service.invoke(principal, body, origin));
        return json(result, INVOKE_HTTP_STATUS[result.status]);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error("[executor-cloudflare] tools route failed", cause);
            return json({ error: "Internal error" }, 500);
          }),
        ),
      ),
    );
};
