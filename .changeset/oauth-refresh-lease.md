---
"executor": patch
---

Keep OAuth connections alive when two sessions or instances refresh the same connection at once: refreshes now coordinate through a lease in the shared database, so a rotating refresh token is only spent once. A tool catalog sync that started and never finished is no longer re-run on every read; it is retried after a 15 minute backoff.
