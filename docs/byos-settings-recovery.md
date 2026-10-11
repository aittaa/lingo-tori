# ChatGPT settings recovery

This scoped follow-up starts from `dfa47e098fb45b19d4dfecc6cad9b5ca88973391`. It preserves that source's callback, credential isolation and renewable-session behavior. It does not change the independent BYOK core.

## Reproduced behavior

Opening settings during an existing sign-in showed a new sign-in button instead of the pending transaction. Reopening settings during a connected account's reconnect also discovered its previous model catalog. Returning to settings reset an explicitly selected, unsaved model before reconciliation.

The settings card now restores the background's safe `authPending` flag, offers cancellation and waits for completion before discovering models. Refresh keeps an unsaved model while it remains in the returned account catalog. Unavailable account/model states still clear unusable selections. No permission request or authentication starts from mounting or refreshing settings.

Three new UI regressions reproduced these failures before the fix. The pre-change scoped suite passed 10 files / 101 tests; the corrected scoped suite passes 10 files / 104 tests using synthetic browser, account and token fixtures. This is development evidence, not a live OAuth result. Parent-owned ChatGPT review is separate.

## Subtitle request diagnosis

The existing draft's author reports user-completed Chrome sign-in and model discovery. Successful live inference is not established, and a video translation failure is reported. This follow-up does not inspect the signed-in browser profile or its credentials.

Two additional synthetic integration tests exercise `aiTranslate`, the real AI SDK adapter and the Responses service together. They verify the selected model, exact subtitle batch input, system instructions, `store: false`, `stream: true`, UTF-8 Korean output and preserved `%%` separators. A rejected model request retains only safe error code/status/parameter/request ID, with no retry or provider fallback. The combined scoped run passes 12 files / 115 tests.

An initial UTF-8 fixture failed because the shared test setup's encoder truncates non-ASCII code points. The integration fixture now supplies real UTF-8 bytes explicitly; no product encoding change was needed. Passing synthetic requests does not reproduce or resolve the reported live video failure.

Video subtitles use their explicitly assigned Feature Providers provider. Saving a ChatGPT model does not automatically change that assignment. Further diagnosis needs the video's assigned provider, selected model slug and safe error code/parameter/request ID. Do not include callback URLs, authorization codes, tokens or raw response bodies. Any live inference needs a separately confirmed exact model, input and account/quota boundary.

## Local validation

The isolated worktree references the already prepared dependency packages, with its own writable tool caches. Run the installed tools directly to avoid pnpm's pre-script dependency repair writing to the primary checkout:

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/oxfmt --check src/entrypoints/options/pages/byos/index.tsx src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/utils/byos/__tests__/translation-integration.test.ts docs/byos-settings-recovery.md .changeset/restore-chatgpt-settings.md
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Local logs are in `.output/byos-recovery/`. The normal package commands remain unchanged. An initial run stopped at cache/permission setup before tests started; it is not a product-test failure. No install hooks, server, live authorization, permission grant or inference is needed for these scoped checks.

PASS: scoped tests, full type-aware lint/type check, owned-file formatting, diff whitespace and changeset status. Chrome and Firefox MV3 builds pass at the UI fix commit `ca4ad28b`; subsequent changes add only tests and this document. Outputs are `.output/chrome-mv3` and `.output/firefox-mv3`, each reported as 14.64 MB unpacked by WXT. The complete repository test suite was not rerun in this follow-up.

## Separate user acceptance

Real OAuth, optional callback permissions and inference require explicit confirmation at the time of each action. Neither source review nor mocked tests proves browser interoperability or account eligibility. The experimental browser-only design's official-support limits remain in [BYOS](byos.md).

After the parent reviews the exact candidate commit and the user authorizes the relevant browser/account actions:

1. Use the candidate `.output/chrome-mv3` in a separate Chromium test profile. Loading a different unpacked path can give it a different extension ID and isolated account storage; do not copy existing credentials into it.
2. Confirm settings is usable without an account and that opening/refreshing it never prompts for permission or starts sign-in.
3. With separately confirmed permission/OAuth actions, start sign-in, reopen settings while it is pending and verify the waiting/cancel state. Complete the user-owned flow and return to settings to verify connection and account-specific model discovery.
4. If two models are available, select another without saving, move focus away and back, and confirm the choice remains. Save it explicitly and assign a feature explicitly.
5. Do not invoke translation as part of this UI pass. A real inference request needs its own confirmation and result; report browser errors by stage without copying callback URLs, authorization codes or tokens.

Browser acceptance is NOT RUN in this follow-up. No merge, auto-merge, release or deployment is authorized by passing these checks.
