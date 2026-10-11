# BYOS streams with omitted Content-Type

The server Mac Smoke profile reproduced the installed error `BYOS: invalid_stream` on an English YouTube video with its existing connected ChatGPT account and saved `GPT-6.1-Sol` display model. The pinned PR32 production build at `3a5adddd9a2738264bbc95f3baafae973b814bf0` narrowed the same real failure to `invalid_stream_content_type`. Its source tree is `ded99ef65218a3f7489e987f5f95a3eb18db327c`.

Local diagnostic builds exposed only bounded machine categories: HTTP 200, missing Content-Type and no recognized upstream error code. Adding `Accept: text/event-stream` did not fix the real flow and is excluded from this change. Raw request/response bodies, headers, OAuth callbacks, credential records and tokens are excluded from the evidence.

The parser now permits only an absent Content-Type to continue into the existing SSE validation. Explicit non-SSE or empty MIME values still fail. UTF-8 decoding, framed event parsing, delta types, terminal `response.completed` status, refusal/error handling, limits, generation checks and nonretryable accepted-stream failures remain enforced. There is no JSON/HTML response fallback or upstream endpoint change. The official [plan inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) requires streamed Responses and completed inference.

## Real browser acceptance

- Chrome 154.0.8037.98, extension version 1.50.3, existing Smoke profile and extension ID preserved across build replacements. The existing account, saved model and video provider assignment remained connected; no new OAuth grant, registration, API key or payment was needed.
- Same public video, paused at 0 seconds, subtitles OFF, explicit ON and Play sequence on the baseline and candidate.
- The candidate rendered Korean translation alongside the English source. The unchanged production adapter only emits invocation text after strict stream completion. The completed wire event was not separately captured; completion follows from that production path, while the rendered translation is directly observed in native accessibility/screenshots.
- Pause and subtitles OFF were verified. Cancellation while pending and explicit retry remain unverified: the Mac locked before that next scenario and requires manual unlock.
- Raw screenshots and structured native E2E events remain in the local scratchpad; no credential-bearing UI or payload is published. Native screenshots are available, while a faithful CDP video recording of this existing Smoke profile was unavailable through the supported control surface.

These are actual browser/account observations, not mocked provider success. They cover the initial translation flow only and do not establish every model, account, stream lifecycle or refresh behavior.

## Synthetic regression coverage and merge gate

New cases cover headerless LF/CRLF/CR streams split into individual bytes; missing bodies; JSON/HTML impostors; malformed events/deltas; interrupted or unterminated completion; post-completion frames; refusals and explicit failures. Explicit HTML/plain/octet-stream and empty MIME headers remain rejected even when their bodies resemble SSE.

The new unit cases are prepared but have not been run. Repository instructions reserve automated source tests for immediately before merge. Existing PR32 results do not validate this changed tree. At the merge gate, run the focused file with the cached Node 26.11.1 runtime and `SKIP_FREE_API=true`:

```sh
SKIP_FREE_API=true node_modules/.bin/vitest run src/utils/byos/__tests__/responses-stream.test.ts --maxWorkers=2 --reporter=dot
```

This material stream change remains a draft pending the parent's Pro review, remaining browser cancellation/retry acceptance and the offline merge gate. No merge or Actions enablement is included.
