# Accepted-stream timeout recovery

Base: PR40 at `4df4f4114ea86716040207ac87d1cb19c356a974`. A mocked HTTP 200 SSE supplied a partial delta and then stalled. The real SDK/adapter and RequestQueue made three inference calls with two retries, although all three later service abort errors were nonretryable. The outer queue's timeout won first. Baseline: `.output/byos-cumulative-review/reconciliation.log`; reproduction source and assessment are retained locally beside it.

Once authenticated Responses returns successfully, synchronously mark the caller's abort reason nonretryable during its abort event. The queue and SDK-composed signal share this reason object in the background invocation path, so the queue sees the marker before its retry decision, rather than waiting for reader/SDK rejection to unwind. Remove the listener on completion/failure. No queue policy, endpoints, account state, permission, or inference payload changes.

Regression evidence: an accepted stalled stream now makes one call; pre-admission BYOS timeouts and ordinary synthetic BYOK timeouts retain three attempts. The fixture uses a 40 ms deadline to exercise the same timer/race path quickly; production defaults remain 20 seconds with two retries and existing per-batch overrides. This proves request counts, not actual usage charges. Baseline diagnostic assertions expecting three service failures now receive one; new desired-behavior tests pass.

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=2 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

PASS: 16 focused files / 175 tests, the final three timeout/control cases, full type-aware lint/type check, formatting, diff and changeset checks. Chrome MV3: 5.943 seconds / 14.64 MB; Firefox MV3: 8.752 seconds / 14.64 MB. Candidate logs: `.output/byos-cumulative-review/timeout-*`; extension builds: `.output/chrome-mv3/` and `.output/firefox-mv3/`. Worktree: `/tmp/lingotori-byos-cancel-scope-20261011`. Test workers are bounded to two and builds are serial; memory is queried between stages (35% free at the post-test checkpoint).

PR41 at `96373d4338da1e91ac50910bcce589452480529f` is a separate branch and is not integrated or validated with this delta. No live account/inference/browser operations, merge, deployment or Actions enablement. This material behavior fix remains a dependent draft pending the parent's review.
