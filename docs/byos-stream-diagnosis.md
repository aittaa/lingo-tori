# Responses stream diagnosis

This follow-up starts from the reviewed settings recovery commit `324a14645a629be5c883ba9dd21cb06c5df731a8` in draft #20. The user reports an established ChatGPT connection, selected display model **6.1 Sol**, and the complete visible video-translation error **BYOS invalid_stream**. No raw response, content-type or model slug was observed. The display name does not establish the exact wire model ID.

## What the error establishes

The subtitle host calls the AI SDK BYOS adapter, which invokes the background Responses service. The request already sends `store: false` and `stream: true`. The reported code is emitted after receiving the HTTP response: for an unexpected content-type/body, malformed JSON, invalid event shape, a non-string text delta or a frame after completion. The old single code cannot identify which condition occurred.

The official [ChatGPT plan inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) requires streamed Responses and a completed terminal event. A JSON/nonstreaming response must not be accepted as a successful fallback. The [Responses streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses) describes typed lifecycle/text/error events. Reasoning and other non-text events are tolerated without adding them to translated text.

## Confirmed parser defects and fix

Deterministic fixtures reproduced four defects: valid CR-only SSE framing and case-insensitive event-stream MIME values were rejected; a MIME value merely containing `text/event-stream` was accepted; an unframed terminal event at EOF could be treated as completion. These are source defects, not proof of the user's actual wire failure.

The parser now accepts LF, CRLF and CR line endings across arbitrary byte chunks, compares the normalized MIME essence exactly and requires a complete SSE frame before accepting `response.completed`. UTF-8 decoding and the four-megabyte limit remain. The [SSE parsing standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) defines the line-ending and EOF behavior.

Failures now distinguish `invalid_stream_content_type`, `invalid_stream_body`, `invalid_stream_json`, `invalid_stream_event`, `invalid_stream_delta` and `invalid_stream_after_completed`. They expose only the safe machine code, HTTP status and validated request ID. Raw content-type values, events, headers, error bodies and credentials are not logged or returned.

No callback, OAuth, credential-vault, refresh or provider-assignment behavior is changed. No model-specific endpoint or fallback is introduced. Tests use a synthetic request with the documented example model ID; they do not establish which slug the user's selected model used.

## Reproduction and validation

The initial 13-case fixture run had 2 passes and 11 failures: four expose parser defects; seven expose the previously collapsed diagnostic stages. A subsequent fixture also covers a complete Sol-style reasoning/lifecycle/text sequence split into individual bytes. All account, token and HTTP values in these tests are synthetic.

Run the prepared tools directly in the isolated worktree:

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos src/entrypoints/options/pages/api-providers/__tests__/byos-settings.test.tsx src/entrypoints/options/pages/byos src/utils/host/translate/api/__tests__/ai.test.ts --maxWorkers=4 --reporter=dot
node_modules/.bin/oxlint --type-aware --type-check
node_modules/.bin/wxt build
node_modules/.bin/wxt build -b firefox --mv3
```

Logs remain in `.output/byos-recovery/`. Record final results separately from the reproduced failures. Installed-browser behavior and live inference are NOT RUN. A future separately authorized runtime request can distinguish the failure stage using the new safe code/status/request ID without exporting raw wire data. No longer error text or credential-bearing screenshot is required from the user now.

Final PASS: 13 scoped files / 130 tests (2.88 seconds), including 15 wire cases; full type-aware lint/type check; owned-file formatting; whitespace and changeset checks. Chrome MV3 builds in 5.234 seconds and Firefox MV3 in 5.104 seconds, each reported as 14.64 MB unpacked. Artifacts are `.output/chrome-mv3` and `.output/firefox-mv3`. The complete repository test suite was not rerun. These results do not establish the actual server response shape or live inference success.
