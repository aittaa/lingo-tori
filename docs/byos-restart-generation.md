# Reconnect generations after interrupted refresh

The remaining P2 is reproducible at draft #25 and the unchanged refresh-recovery path in draft #31 (`344df49221528aa35e07f8518993d02bd3dd7f60`). Existing credentials plus a pending reconnect and durable `refreshing: true` advanced the vault generation while retaining the pending attempt's old generation. Initialization then reconciled its stale pre-update snapshot. The genuine synthetic callback failed with `invalid_oauth_state`, despite being from the expected sender/tab with its original state and PKCE verifier. An already-stale pending attempt also remained pending.

Baseline: two new regressions fail; claimed/expired replay guards pass (2 failures / 2 passes). Log: `.output/byos-recovery/restart-generation-baseline.log`. The fixture first establishes a signed synthetic account, starts a reconnect, simulates an interrupted refresh, restarts the service and uses the real callback validation path. No live token or network is involved.

Advance the vault generation, token version and eligible pending generation in the same vault transaction. Rebind only an unclaimed, unrelayed, unexpired pending attempt already belonging to the pre-update generation. Preserve its state, nonce, PKCE verifier, client, subject, tab and expiry. Return the committed record from that transaction and reconcile that snapshot. Retire already-stale, claimed, relayed or expired attempts rather than reviving them.

The interrupted refresh remains uncertain and cannot reuse its rotating refresh token. Prior credentials remain intact under the existing expiration rules. A successful fresh authorization-code exchange still requires sender/frame/tab/state/client/subject/nonce/signature validation and clears uncertainty only after validated new credentials are committed. The tests verify the original PKCE verifier, one fresh authorization-code exchange, and no refresh-token replay.

## Validation

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Logs: `.output/byos-recovery/restart-generation-*`. Artifacts: `.output/chrome-mv3/` and `.output/firefox-mv3/`. Live credentials/browser/inference/grants and separate reviewer execution are NOT RUN.

PASS: 15 focused files / 161 tests, full type-aware lint/type check, formatting, diff checks and Chrome/Firefox MV3 builds. The valid reconnect completes through synthetic signature/nonce/PKCE checks; stale, claimed and expired attempts reject without token exchange.
