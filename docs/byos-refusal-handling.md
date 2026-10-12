# Responses refusal handling

This separate follow-up starts from reconnect recovery `6d5ebcb843e27c0aed61f97ae2d7ab4b08ddcd0a` in draft #22. It addresses a confirmed inherited refusal-handling defect. It does not establish the cause of the reported **6.1 Sol / BYOS invalid_stream** video failure.

## Reproduction

The service previously accumulated only `response.output_text.delta`. Valid `response.refusal.delta` / `response.refusal.done` events followed by completion returned `{ text: "" }`, which the real SDK adapter treated as successful output. A two-item synthetic subtitle batch then reached the result-count mismatch path and individual fallback. The initial wire regression run had 5 failures / 17 passes. Repeating the host/queue regressions against the exact baseline with a 100 ms batch delay produced 2 failures / 2 passes: one batch fetch and two individual fallback calls. The first fixture used a zero delay and flushed separate single-item batches; it did not establish the fallback behavior. The corrected baseline log is `.output/byos-recovery/refusal-host-baseline.log`.

The official [Responses streaming reference](https://developers.openai.com/api/reference/resources/responses/streaming-events) defines partial and finalized refusal events separately from translated text. Refusal text is not usable translation output.

## Behavior

Validate the refusal event fields and record only a refusal flag. Never concatenate, return or log refusal text. A refusal returns the safe `inference_refused` error instead of empty or partial translation success. Successful output still requires a framed `response.completed`; a refusal remains an error even if its stream is interrupted.

After a valid refusal, mark subsequent errors nonretryable while preserving their original identity and machine details. An upstream failure remains that failure; interruption remains an error, and neither replays the refused request. Existing request/batch queue behavior needs no product changes: the refusal is not a result-count mismatch and cannot reach individual fallback. Other queued requests and the connected account are not invalidated.

The regression suite covers refusal-only, finalized-only and mixed text/refusal streams, malformed refusal fields, interruption and an upstream failure after refusal. Real SDK and request/batch queue tests verify one synthetic fetch, rejected batch members, no individual fallback and an intact plan-enabled session.

No prompt rewriting, alternative model/provider request, refusal bypass, new grant, credential access or live inference occurs. Callback, refresh, permissions and config behavior are unchanged. Unreproduced cancellation-race and data-whitespace observations remain outside this patch.

## Validation

Use the prepared local tools:

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Final results:

- PASS: 13 focused test files / 141 tests, including the corrected real SDK/request/batch regression. Log: `.output/byos-recovery/refusal-final-focused.log`.
- PASS: full type-aware lint and type check. Log: `.output/byos-recovery/refusal-lint-types.log`.
- PASS: formatting of the five changed files, `git diff --check` and changeset status. Logs: `.output/byos-recovery/refusal-format.log` and `.output/byos-recovery/refusal-changeset.log`.
- PASS: Chrome MV3 build in 10.8 s and Firefox MV3 build in 5.868 s; each totals 14.64 MB. Artifacts: `.output/chrome-mv3/` and `.output/firefox-mv3/`. Logs: `.output/byos-recovery/refusal-chrome-build.log` and `.output/byos-recovery/refusal-firefox-build.log`.
- NOT RUN: installed-browser behavior, actual inference, paid API and separate reviewer validation.

All new network fixtures use synthetic streams and memory-only synthetic credentials. Drafts #20, #21 and #22 retain their exact commits; no merge or auto-merge is authorized by source checks.
