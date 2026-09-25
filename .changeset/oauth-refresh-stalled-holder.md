---
"executor": patch
---

OAuth connections no longer get revoked when a refresh stalls. A refresh that lost its lease, or has too little of it left, no longer sends the spent refresh token; the token request is bounded to end before the lease does; the lease is renewed before a slow save; and an invalid_grant that a peer's newer refresh already superseded returns the peer's token instead of marking the connection as needing a reconnect.
