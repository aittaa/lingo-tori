---
"@lingotori/extension": patch
---

fix(auth): preserve pending ChatGPT callback routing across background restarts and correct session error recovery

Keep credentials through transient refresh failures, allow recovery after request limits, attempt remote revocation on sign-out, and restore the sign-in button when an attempt ends.

Recover refused loopback returns through a background navigation handler that verifies the pending tab, exact callback address, expiry, generation and state before relaying to the existing callback page.

fix(docs): remove internal handoff metadata and obsolete companion references from public source artifacts
