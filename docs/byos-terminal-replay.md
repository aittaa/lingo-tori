# BYOS terminal stream replay

The P1 finding remains reproducible at draft #25 (`e2a594c092d58d0268ee572afb36189317a81ae3`). Its refusal handling already stops replay after refusal; other accepted Responses failures had no nonretryable marker.

Five synthetic cases exercise the real AI SDK and RequestQueue with the production retry budget of two: invalid content type, malformed SSE JSON, `response.failed`, `response.incomplete` and EOF after partial output. Each made **three inference requests** before rejecting on the baseline. The four existing integration cases passed. Baseline log: `.output/byos-recovery/terminal-baseline.log`.

After a successful HTTP response, reject framing, parsing, terminal and interrupted-stream failures as nonretryable while preserving their safe code, status and request ID or original error identity. Such an accepted request may already have consumed plan usage. This test proves repeated requests, not actual charges. A fresh explicit request remains allowed and is tested successfully after every failure; account state stays plan-enabled. Pre-stream admission failures retain their existing bounded recovery policy. No central queue policy or auth state changes are needed.

Official OpenAI documentation separates failed/incomplete/interrupted streams from completed inference and its example disables SDK retries: [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). Admission failures have separate recovery guidance: [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

## Validation

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Logs use `.output/byos-recovery/terminal-*`; build artifacts use `.output/chrome-mv3/` and `.output/firefox-mv3/`. All network responses and credentials are synthetic. Live account/browser/inference, billing, grants and separate reviewer execution remain NOT RUN.

PASS: 13 focused files / 146 tests, full type-aware lint/type check, formatting, diff checks and Chrome/Firefox MV3 builds. Every new queue case uses one automatic inference request and then permits a fresh explicit request.
