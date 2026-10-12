# Request-scoped contextual BYOS failures

Base: PR52, `8e3b7e3f3c522720ed8fb2fce071c87ccfff5dfc`. At PR40 the real service/SDK/RequestQueue reproduced one `subscription_sharing_invalid_user` HTTP 401 draining three tasks: the denied BYOS request, an executing unrelated synthetic BYOK request, and a waiting BYOK request. Credentials remained unchanged. Evidence: `.output/byos-cumulative-review/reconciliation.log` and `assessment.json`.

Only contextual/admission BYOS HTTP 401 errors receive enumerable `failQueue: false`, including the response after one bounded token-refresh resend. Explicit token rejection codes retain existing access-rejection and fatal behavior. Preserve the safe error code/status/request ID and fail the denied request without retry or fallback.

Forward the optional flag through existing request error metadata. The fatal-status policy defaults to its existing queue-draining behavior when the flag is absent; an explicit false fails only the current task. No queue partitioning, scheduler change, provider rerouting, account state or credential weakening. Ordinary BYOK 401/403/404, timeout/retry and rate-limit behavior remain covered by existing tests.

The SDK/queue regression now finishes both unrelated BYOK tasks after the contextual BYOS denial. Its BYOK authentication control still drains both peers. Unit regressions verify classification on initial and post-refresh contextual responses and metadata forwarding.

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts src/utils/request --maxWorkers=2 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

PASS: 23 focused files / 334 tests, final seven service-classification cases and two SDK/queue isolation controls, full type-aware lint/type check, formatting, diff and changeset checks. Chrome MV3: 5.990 seconds / 14.64 MB; Firefox MV3: 7.762 seconds / 14.64 MB. Candidate logs: `.output/byos-cumulative-review/context-queue-*`; builds: `.output/chrome-mv3/` and `.output/firefox-mv3/`; worktree: `/tmp/lingotori-byos-cancel-scope-20261011`. At most two test workers and serial browser builds; post-test memory free percentage was 37%.

This dependent delta includes PR52, but PR41 (`96373d4338da1e91ac50910bcce589452480529f`) remains separate and has not been integrated/tested here. All accounts, provider models, responses and permission operations are synthetic/mocked. No live account/inference/browser operation, merge, deployment or Actions enablement. Material behavior remains pending the parent's review.
