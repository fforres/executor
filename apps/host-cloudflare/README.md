# @executor-js/host-cloudflare

Executor as a single Cloudflare Worker. The fourth app on the shared
`ExecutorApp.make` facade (alongside cloud, self-host, and local) — same code
paths, different injected providers:

| Seam         | Cloudflare provider                                              |
| ------------ | ---------------------------------------------------------------- |
| **identity** | Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) — no app login |
| **db**       | D1 (SQLite) via the shared FumaDB assembly                       |
| **engine**   | QuickJS-WASM, in-Worker (no extra binding)                       |
| **mcp**      | Access-JWT auth + the shared in-process session store            |
| **account**  | `/account/me` from the Access principal (members/keys → Access)  |
| **web**      | the shared multiplayer SPA (Workers Static Assets)               |

Single-tenant: every Access-verified principal belongs to the one configured
org. Members and credentials are managed in Cloudflare Access, not in-app.

## Surfaces

- `GET /` — the shared Executor web UI (Sources, Connections, Secrets,
  Policies) — the same shell as cloud/self-host, built by `vite build` into
  `dist/` and served via Workers Static Assets (`single-page-application`
  fallback for client routes).
- `/api/*` — the full Executor API (scopes, sources, secrets, account, …).
- `/mcp` — streamable-HTTP MCP with an `execute` tool.

`run_worker_first` in `wrangler.jsonc` keeps `/api/*` + `/mcp` on the Worker;
everything else is the SPA. Every API/MCP route is gated by the Access JWT (401
without). The SPA's auth context reads `/api/account/me`.

## Deploy

```bash
bunx wrangler login
bun run deploy:setup    # apps/host-cloudflare — provisions D1 + secret + deploys
```

`deploy:setup` (scripts/deploy.sh) is idempotent. It creates or reuses the
`executor` D1 database, writes its id into `wrangler.jsonc`, generates and
uploads `EXECUTOR_SECRET_KEY`, then deploys. It then prints the one manual step.

### The one manual step — Cloudflare Access

After the first deploy, API and MCP requests return 503 and name the missing
Access variables until configuration is complete. In the Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted**
2. Application domain: `posse-executor.<your-subdomain>.workers.dev`
3. Add an Access policy (e.g. _Emails ending in `@yourcompany.com`_)
4. Copy the Application **Audience (AUD)** tag, then:
   ```bash
   bunx wrangler deploy \
     --var ACCESS_AUD:<aud> \
     --var ACCESS_TEAM_DOMAIN:<your-team>.cloudflareaccess.com \
     --var ADMIN_EMAILS:<admin@example.com>
   ```

Now visiting the Worker prompts an Access login; the Worker validates the issued
JWT on every request. Unauthenticated requests return 401. MCP clients present
an Access JWT or `Cf-Access-Client-Id`/`-Secret` service-token headers.

The Access values are live Worker variables, not values in `wrangler.jsonc`.
Wrangler's `keep_vars` option preserves them during later code deploys. Run the
command above again whenever you need to change them.

## API keys and a public API/MCP

Agents and MCP clients that cannot do an Access browser login authenticate with an
API key instead, so `/api/*` and `/mcp` can be public while still gated:

```bash
bun run apps/host-cloudflare/scripts/api-key.ts create --label posse
```

The command prints the plaintext key once (hand it to the caller, who sends
`Authorization: Bearer exk_...` or `x-api-key: exk_...`) and a `label:hash` entry.
Only hashes are stored: put the entries (comma-separated for several keys) in the
`EXECUTOR_API_KEY_HASHES` secret and set `API_KEY_PRINCIPAL_EMAIL` to the owner's
email. Every key acts as that admin, and because identity is keyed on the email it
resolves to the same account as that person's browser session, so personal
connections are shared. A wrong key is a 401; it never falls back to another
credential.

The Access JWT is read from the `Cf-Access-Jwt-Assertion` header or the
`CF_Authorization` cookie, so Access only has to front the UI paths: the browser
logs in there and the cookie (set for the whole hostname) then authenticates the
UI's own `/api` calls. Leaving both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` unset
with API keys configured is a valid API-key-only deployment.

Routes that must stay reachable without an Access login: `/mcp*`, `/api/*` for
key-authenticated callers, `/.well-known/*` (MCP discovery, OAuth client metadata)
and the OAuth callback `/api/oauth/callback`. The callback is hit by the provider's
redirect in the browser that started the flow, so it authenticates with that
browser's `CF_Authorization` cookie; do not put it behind an Access policy that
would redirect it away.

`ENABLE_DEV_AUTH` is refused at boot (503) when `ACCESS_AUD` is set or
`ENVIRONMENT=production`.

## Three doors

The same Worker is reachable three ways, and each resolves to a principal
differently.

1. **Public API-key door** (`/mcp`, `/api/*`, `/v1`, `/.well-known/*`). Agents
   and MCP clients send `Authorization: Bearer exk_...` (or `x-api-key`). The key
   is matched against the hashes in `EXECUTOR_API_KEY_HASHES` and acts as the
   `API_KEY_PRINCIPAL_EMAIL` admin. Keep these paths out of the Access policy
   (an Access Bypass application for them) so the worker alone gates them.
2. **Access UI door** (everything else, mainly `/`). A browser goes through
   Cloudflare Access; the Worker verifies the JWT from `Cf-Access-Jwt-Assertion`
   or the hostname-wide `CF_Authorization` cookie, which is also what
   authenticates the UI's own `/api` calls and `/api/oauth/callback`.
3. **`ExecutorInternal` service-binding door.** Workers in the same Cloudflare
   account call the Worker through a service binding with no credential and act
   as the owner (`API_KEY_PRINCIPAL_EMAIL`). The entrypoint has no public route
   and builds its own trusted app; nothing in a request or in `env` can turn the
   public door into this mode. In the calling worker's `wrangler.jsonc`:

   ```jsonc
   "services": [
     { "binding": "EXECUTOR", "service": "posse-executor", "entrypoint": "ExecutorInternal" }
   ]
   ```

   Then `await env.EXECUTOR.searchTools({ query: "..." })` and
   `await env.EXECUTOR.invokeTool({ ... })` (RPC, returning `{ status, body }`),
   or `env.EXECUTOR.fetch(request)` for any other route.

## Local development

```bash
# .dev.vars
EXECUTOR_SECRET_KEY=dev-secret-key-0123456789abcdef
ENABLE_DEV_AUTH=true     # bypass Access; every request is a fixed dev admin

bun run build            # vite build -> dist/ (the SPA)
bunx wrangler dev --local   # serves the SPA + Worker API together
```

`bun run dev:web` runs the Vite dev server (HMR) for UI work; point its API at a
running `wrangler dev` if you need live data.

`ENABLE_DEV_AUTH` is a dev-only escape hatch — never set it in a deployed
environment (it disables the Access gate).

## Notes

- The QuickJS engine WASM is vendored into `src/quickjs-engine.wasm` (Workers
  forbid runtime WASM compilation; it must be statically imported). Refresh it
  after bumping the engine with `bun run vendor-wasm`.
- MCP sessions live in-process (one isolate owns a session). The cross-isolate
  upgrade is a Durable Object behind the same `McpSessionStore` seam.
- When Cloudflare's dynamic Worker Loader leaves closed beta, the QuickJS code
  substrate swaps for the dynamic-worker executor behind the `engine` seam — a
  one-Layer change.
