# Model recovery after cancellation cleanup failure

The inherited P3 is reproducible at PR32 (`3a5adddd9a2738264bbc95f3baafae973b814bf0`) and remains at PR38 (`3080e6145658572dcf7abf5ee505aecbceb20232`). Cancellation removes its pending attempt before owned-tab/rule cleanup finishes. If that cleanup rejects or does not settle, the old UI refreshes only on success and leaves a preserved account's model list empty until focus or reopen.

PR38 remains the base for this focused delta. Refresh the current session after cancellation settles, including rejection and the existing 10-second message timeout. Preserve the failure notice; release the busy state after reconciliation. The existing owner checks prevent stale UI operations from updating a newer view, and live session state controls whether the model catalog can be restored. Unexpected refresh errors remain caught. Each background message retains its own 10-second bound; this is not a single deadline for the entire recovery sequence.

Service behavior is unchanged. A real-service regression confirms pending state is removed before cleanup rejects while the prior account survives, with no HTTP calls. Two mocked UI regressions reproduce rejection and timeout and verify immediate model recovery, preserved configuration and no permission request. Existing successful cancellation and stale-attempt tests remain covered.

## Commands and evidence

Worktree: `/tmp/lingotori-byos-cancel-scope-20261011`, branch `codex/byos-cancel-cleanup-recovery-20261011`. Use the existing prepared toolchain (Node 26.11.1, pnpm 12.10.1); these checks invoke installed shims directly without dependency installation or install hooks.

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/oxfmt --check src/entrypoints/options/pages/byos/index.tsx src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/utils/byos/__tests__/cancel-scope.test.ts docs/byos-cancel-cleanup-recovery.md .changeset/byos-cancel-cleanup-recovery.md
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
node_modules/.bin/changeset status
```

Baseline logs: `.output/byos-cancel-review/cleanup-baseline.log` (PR32) and `cleanup-pr38-baseline.log` (PR38: two UI failures, one service contract pass). Candidate logs: `.output/byos-cancel-review/cleanup-tests.log`, `cleanup-lint-types.log`, `cleanup-format.log`, `cleanup-chrome-build.log`, `cleanup-firefox-build.log` and `cleanup-changeset.log`. Built extension directories: `.output/chrome-mv3/` and `.output/firefox-mv3/`.

PASS: 16 focused files / 172 tests, full type-aware lint/type check, formatting, diff checks and changeset validation. Chrome MV3 built in 5.722 seconds and Firefox MV3 in 5.915 seconds; each unpacked build is 14.64 MB. The new changeset requests a patch; the aggregate dependent stack retains its existing minor release plan.

## Review and runtime boundary

E2E keeps `/tmp/lingotori-byos-recovery-20261011` frozen at PR32. This work uses a separate checkout and builds. Its 336 Chrome/Firefox input files were checked against `.output/byos-cancel-review/pr32-input-hashes.json`: no changed or added files. The frozen checkout remains clean at its original commit. The primary checkout remains at `dfa47e098fb45b19d4dfecc6cad9b5ca88973391` with its pre-existing `AGENTS.md` change untouched.

All credentials, tabs, permission requests and network responses in tests are synthetic or mocked. Installed-browser verification, recording, live OAuth, credentials, model discovery, inference and permission grants are NOT RUN. Browser operations belong to the separate E2E owner. This material behavior change and PR38 require the parent's separate Pro re-review before any merge; that review is pending. No merge, auto-merge, deployment, Actions enablement or unrelated service operation is part of this delta.
