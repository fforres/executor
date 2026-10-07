# Fork notes: `posse` branch

The branch is `fef8b438` (upstream) plus the commits below, oldest first. No upstream PRs are open. "Candidate" means the change stands on its own and is useful outside posse; "fork-only" means it exists for posse's deployment.

## Upstream candidates

| Commit                             | What                                                                                  | Notes                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `6a99c997`                         | host-cloudflare: report the Access principal as a member so admins are admins         | Independent bug fix.                                |
| `54ee6494`                         | host-cloudflare: key a person on their email, not the Access `sub`                    | Email identity. Independent.                        |
| `fdc611cb`                         | mcp: send a `User-Agent` on remote MCP requests                                       | Independent.                                        |
| `71faaeb6`, `385443c6`, `0e20b4a3` | sdk: database lease for OAuth refresh, never resend a spent refresh token, formatting | Refresh lease. Touches `core/sdk` only, with tests. |
| `cd8de39e`                         | execution: answer an integration-restricted search from the cached ranking            | Needs `51cdb880`.                                   |

## Mixed: split before proposing

| Commit     | Candidate part                                                                                                                                         | Fork-only part                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `51cdb880` | The `HostConfig.toolDiscovery` seam, `ToolDiscoveryProvider` in `tool-invoker`, `passthrough-api.ts` (search/resolve shared by MCP and other surfaces) | Clef ranking (`clef.ts`, `clef-discovery.ts`) and the `ai` binding in `wrangler.jsonc` |
| `95cfca5c` | `runPassthroughCall`, the `integrations` allow list, `passthroughOverview`, `boundPassthroughResult` in `host-mcp`                                     | Needs `51cdb880`. Written for posse's REST/RPC doors but generic over the host         |

## Fork-only

| Commit                 | What                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `1163e929`             | Delegated subject via a trusted service token. Removed again in `7151d28c`.                                                                  |
| `7fa70983`             | Composite auth: API keys (`EXECUTOR_API_KEY_HASHES`) and the `CF_Authorization` cookie.                                                      |
| `00bb6b48`             | `ExecutorInternal` service-binding entrypoint.                                                                                               |
| `f1a403b2`             | REST `/api/tools/search` and `/api/tools/invoke`.                                                                                            |
| `7151d28c`             | RPC-only internal door, tool service, `loadConfigResult`, same-origin check for cookie-only writes, owner dev principal, delegation removed. |
| `c5ed62b1`, `eb056da7` | Ignore generated config, document the doors.                                                                                                 |
| `f9b42659`             | Test fixture fix for `passthrough-api` (goes with `51cdb880`).                                                                               |
