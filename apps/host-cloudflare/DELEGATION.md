# Delegated subjects on the Cloudflare host

## The problem

Executor scopes every row by `(tenant, owner, subject)`. A row is visible when
`owner = 'org'` **or** `subject` matches the caller's. Org-owned connections
therefore work for any caller, and personal connections work only for the person
who owns them.

On this host, identity comes entirely from Cloudflare Access, which issues it two
ways:

- a **human in a browser** carries `email` + `sub`, so the subject is their Access `sub`;
- a **service token** carries `common_name` (the token's client id) and no email,
  so the subject is _the token_.

A headless agent can only present a service token. Its subject is never any
human's, so it reaches `owner: 'org'` rows and nothing else. Access has no way to
express "this backend is acting for Alice": there is no delegation primitive in
it, and a backend cannot mint a user's Access JWT.

## What this adds

`applyDelegatedSubject` (in `src/auth/cloudflare-access.ts`) lets ONE configured
service token name the subject it is acting for, using two request headers:

| Header                     | Meaning                                                  |
| -------------------------- | -------------------------------------------------------- |
| `X-Executor-Subject`       | the subject to bind, i.e. that person's Access `sub`     |
| `X-Executor-Subject-Email` | their email, so roles resolve as they would in a browser |

Delegation runs **after** JWT verification, never instead of it. The caller is
always a fully verified Access principal first; delegation only re-binds who that
verified principal is acting for.

## The gate

In order:

1. No delegation headers → the principal passes through untouched.
2. The caller is not the configured delegator → **reject the request** (`null` →
   `Unauthorized`). Silently ignoring the header would let any Access-authenticated
   human probe for delegation and learn whether it is enabled.
3. A delegator naming no subject → reject, for the same reason.

Only a service token may delegate. A human principal always carries an `email`, so
requiring an empty one means a browser session can never delegate, even if it
somehow learned the delegator's id.

## Configuration

Set `ACCESS_DELEGATION_COMMON_NAME` to the `common_name` of the one service token
allowed to delegate. **Unset disables delegation entirely**, which is the correct
default: an instance with no headless agent in front of it should never accept a
delegated subject.

```bash
bunx wrangler deploy --var ACCESS_DELEGATION_COMMON_NAME:<client-id>.access
```

Keep that token the only service token in the Access application's policy, so the
set of principals that can delegate is exactly one.

The calling agent then sends, per acting user:

```http
CF-Access-Client-Id: <client-id>.access
CF-Access-Client-Secret: <secret>
X-Executor-Subject: <that user's Access sub>
X-Executor-Subject-Email: <that user's email>
```

The agent is responsible for mapping its own user identity (a Slack user id, say)
to that person's Access `sub`. A person must have signed in to the console once
before their subject exists.

## Known limitation

Access `groups` are not available to the delegator, so a delegated principal gets
admin from the `ADMIN_EMAILS` allowlist but never group-derived roles. If you rely
on Access groups for authorization, a delegated session will see less than the same
human sees in a browser.

Delegation is also ignored under `ENABLE_DEV_AUTH`, which short-circuits to a fixed
admin before any of this runs.

## Alternative, not implemented: a service binding

If the calling agent is itself a Worker in the same Cloudflare account, a service
binding is a cleaner trust boundary than a service token plus a header:

- no public hop, so nothing on the internet can reach the delegating path;
- no shared secret to rotate;
- the binding itself is the boundary, so the subject header needs no gate beyond it.

It was not taken here because it needs a second auth path for `/mcp` and touches
worker routing, which is a materially larger delta to carry across upstream
releases than one pure function. Worth revisiting if this host ever grows a
first-class non-Access auth seam, or if upstream adds MCP OAuth over Access (see
the note at the end of `src/mcp/auth.ts`, which anticipates exactly that).
