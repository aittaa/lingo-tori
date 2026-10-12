# Owned internal sign-in cancellation

Base: PR56 at `833b88995586d46e17a50d8d3cda2bd0bcdb196c`. At PR40, pausing the vault read after an internal tab-close or expiry event observed T1, finishing T2, then releasing T1 removed T2, advanced its generation and cleaned its tab. The settings CancelAuth path already preserved T2. Baseline evidence: `.output/byos-cumulative-review/reconciliation.log` and `assessment.json`.

Route internal tab-close and expiry cancellation through the existing attempt-scoped CancelAuth transaction. Carry the observed OAuth state/generation as an optional internal expectation and check it atomically before changing intent, generation or pending state. These fields never enter options messages, session replies, configuration or logs. Keep the newer-start protection and owned cleanup behavior already used by settings cancellation. No new queue, authentication transport or storage mechanism.

Six new regressions cover both stale internal routes with different control IDs and with a reused control ID after the replacement transaction is committed, plus matching-owner close/expiry controls. Stale events preserve the entire T2 vault snapshot and perform no additional cleanup. Matching owners still clear pending, advance generation, clean their tab and preserve the prior account. Existing settings, legacy migration, claimed-callback cancellation and in-progress-start protection remain covered.

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts src/utils/request --maxWorkers=2 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

PASS: 23 focused files / 340 tests, full type-aware lint/type check, formatting, diff and changeset checks. Chrome MV3: 6.198 seconds / 14.64 MB; Firefox MV3: 7.440 seconds / 14.64 MB. Logs: `.output/byos-cumulative-review/internal-cancel-*`; builds: `.output/chrome-mv3/` and `.output/firefox-mv3/`. Worktree: `/tmp/lingotori-byos-cancel-scope-20261011`; test workers are bounded to two and browser builds are serial. Memory free percentage: 52% after tests and 47% after builds.

This final dependent tree includes PR52's accepted-stream timeout fix and PR56's contextual-401 isolation. PR41 (`96373d4338da1e91ac50910bcce589452480529f`) remains separate and has not been integrated/tested with this tree. All tabs, credentials, provider models, responses and time controls are synthetic/mocked. No live account/inference/browser operations, merge/auto-merge, deployment or Actions enablement. Parent review remains required for these material behavior changes.
