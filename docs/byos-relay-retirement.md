# Retiring indeterminate callback relays

The P2 relay finding remains reproducible at draft #25 and the unchanged callback path in draft #29 (`b77de906bad4f01d251b0fdb707a6d7cb6d27a76`). `relayStarted` was committed before navigation; a rejected navigation or worker restart could leave an unconsumed claim and `authPending: true` until manual cancellation or expiry. Two new baseline regressions fail; the new claimed-callback and replacement-attempt race guards already pass. Log: `.output/byos-recovery/relay-retirement-baseline.log`.

Use fail-closed recovery: retire an unclaimed relay attempt when navigation fails or becomes ambiguous, and retire durable unconsumed relay claims during worker initialization. Cleanup removes that owned attempt's rule/tab and advances its generation. The prior account credentials remain intact; the user can explicitly start a fresh login with a new state, nonce and PKCE verifier. A successful relay in the same worker retains the existing callback flow.

Retirement checks intent, generation, pending state and the unclaimed flag atomically. A late failure cannot cancel a replacement sign-in or an already-claimed code exchange. Do not roll back one-shot authorization claims or replay the old callback, and do not store callback codes for later replay. An unconsumed successful navigation interrupted by worker restart is also treated as indeterminate; the user starts a fresh sign-in rather than reusing that authorization result.

Existing strict sender/frame/tab/state/port/PKCE/nonce/account checks and duplicate/restart replay rejection remain in force. Four new regressions cover navigation failure, durable-claim restart, a claimed callback after an ambiguous acknowledgement and a late error after replacement. They use only mocked tabs and memory-only synthetic credentials.

## Validation

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Logs: `.output/byos-recovery/relay-retirement-*`. Artifacts: `.output/chrome-mv3/` and `.output/firefox-mv3/`. Live credentials/browser/inference/grants and separate reviewer execution are NOT RUN.

PASS: 14 focused files / 157 tests, full type-aware lint/type check, formatting, diff checks and Chrome/Firefox MV3 builds. The two baseline failures now leave no pending relay and preserve the connected account; the two added race guards and existing replay/security cases pass.
