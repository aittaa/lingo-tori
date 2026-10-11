# Scoped settings cancellation

The inherited P2 remains reproducible at PR32 (`3a5adddd9a2738264bbc95f3baafae973b814bf0`): an old settings page's unscoped Cancel deletes a newer pending login. The baseline models T1 then T2 through the real service and the old cancellation route. Log: `.output/byos-cancel-review/scope-baseline.log`.

Use a separate UUID control identifier for each sign-in button attempt. Carry it through Auth, persisted pending state, the private settings session and CancelAuth. OAuth state, nonce, PKCE verifier and credentials remain private. On worker initialization, assign a control identifier to eligible legacy pending records without changing their OAuth binding. Missing/malformed cancellation identifiers fail validation, including old unscoped messages; an old settings page should be reloaded.

The background keeps its strict options-page sender check. Cancellation matches the control identifier atomically before changing intent, generation or pending state. An old T1 cannot cancel T2, including while T2 is still starting before its pending record is committed. The matching owner can cancel its own in-progress start. Existing internal tab-close/expiry cancellation remains available to trusted background events.

Settings capture one identifier before permission awaits and use that same value for authentication-failure cleanup. Reopened settings restore the identifier from the private session; they do not discover or expose OAuth secrets. Tests cover stale pages, restart, the in-progress replacement race, own early cancellation, legacy/invalid messages and legacy record migration.

The inherited P3 cleanup-failure UI recovery was separately reproduced against PR32 with both immediate rejection and the existing 10-second message timeout. Log: `.output/byos-cancel-review/cleanup-baseline.log`; its source fix is a separate follow-up.

## Isolation and validation

Worktree: `/tmp/lingotori-byos-cancel-scope-20261011`. E2E owns `/tmp/lingotori-byos-recovery-20261011` at PR32; that source and its existing builds remain untouched. Hashes of 336 input build files were recorded locally in `.output/byos-cancel-review/pr32-input-hashes.json` before this work.

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

All tabs, permission requests, HTTP and credentials are synthetic/mocked. No actual browser operations or live account/inference/grants occur. Logs: `.output/byos-cancel-review/scope-*`; isolated build artifacts: `.output/chrome-mv3/` and `.output/firefox-mv3/`. This material authentication behavior change requires the parent's separate Pro re-review before merge.

PASS: 16 focused files / 169 tests, the final seven scoped-cancellation regressions, full type-aware lint/type check, formatting, diff checks and Chrome/Firefox MV3 builds. E2E input hashes remain unchanged.
