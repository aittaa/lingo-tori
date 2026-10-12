# Contextual 401 recovery

The second P1 remains reproducible at draft #25 and the unchanged auth path in draft #27 (`ed6bdce68eb8a2c0f3e05b125871f9ceb2c261c0`). Every HTTP 401 set `accessRejected` before classifying its safe machine code, so a subscriber-context or admission failure poisoned later access even with unexpired credentials. The bounded resend also poisoned a freshly rotated token if its response had a contextual 401.

Baseline: five new regressions failed, while the explicit invalid-token security regression passed. Both `/models` and `/responses` reproduce the fault with structured subscriber-context errors and unstructured admission errors. Log: `.output/byos-recovery/context-401-baseline.log`.

Classify the response first. Persist access rejection only for explicit `token_expired`, `invalid_token` or `invalid_api_key` HTTP 401 errors. Context/admission failures still reject the current request with their safe code/status/request ID; they do not trigger refresh or report success. A subsequent explicit request must still be accepted by the API. Apply the same classification after the one bounded token-refresh resend. The generation/token-version/token-identity guards remain intact.

The official [OpenAI Errors and recovery documentation](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) distinguishes direct-admission and subscriber-context failures from confirmed revocation and terminal refresh errors. No grant, scope, account or credential validation is weakened. Explicit token rejection, unusable refresh tokens, uncertain rotation and expiration retain their existing fail-closed behavior.

The former uncertain-refresh test now uses explicit `invalid_token` to test actual access rejection. A separate contextual-401 case preserves valid access until expiry, keeps the uncertain refresh token unused and then requires reconnect.

## Validation

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Logs: `.output/byos-recovery/context-401-*`. Build artifacts: `.output/chrome-mv3/` and `.output/firefox-mv3/`. All credentials, OAuth responses and transport are synthetic. Live browser/accounts/inference/grants and separate reviewer execution are NOT RUN.

PASS: 14 focused files / 153 tests, full type-aware lint/type check, changed-file formatting, diff checks and Chrome/Firefox MV3 builds. The seven new cases cover both contextual request paths, the bounded resend, explicit invalid-token rejection and uncertain rotation through expiry.
