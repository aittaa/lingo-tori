# Feature API usage

Issue #47 adds `/api-usage` to extension settings and settings search. The page uses the existing theme and English, Korean and Japanese locales. It is a local activity counter with a manual refresh button.

## Counting contract

- An attempt is a call at the provider's `fetch` dispatch boundary, after local preparation/validation. It is not proof that bytes reached a server, that the server admitted a request, or that valid output completed.
- Retries, batch fallbacks and SDK transport subrequests/polling each count when they dispatch. A batch fetch counts once, regardless of its number of text members. Stream chunks and response parsing never increment counters.
- Cache hits, deduplicated followers and cancelled tasks that never dispatch do not count. A dispatched request remains counted if it later fails, times out or is cancelled.
- API/local endpoint attempts and ChatGPT subscription (BYOS) inference attempts have separate columns. BYOS is observed only for `/responses` after the existing configuration, credential, upstream and generation checks. Its bounded expired-token resend counts again; token refresh and model lists do not.
- Authentication, model discovery, connection checks, subtitle downloads, the retired input-translation feature and Translation Hub are outside the dashboard. No token totals, cost estimate, success/failure breakdown or subscription quota is shown.

Current fixed categories are page translation (including titles), selected-text translation, video subtitle translation, dictionary, sentence explanation, custom AI actions, reading/note suggestions, page context summary, subtitle context summary, video summary, AI subtitle segmentation and AI language detection. Shared/older requests cover mixed batches and callers without a recognized feature label. A mixed batch is kept intact and counted once in that row, rather than duplicated across multiple features or split merely for statistics. Labels are excluded from cache/dedup identities and batch grouping.

## Retention and privacy

`local:apiUsageV1` stores only schema version `1`, the first counting timestamp and two integer counts for each fixed feature. Counting begins with the first observed attempt after installation of this version; previous activity is unknown. Totals persist across worker/browser restarts indefinitely with bounded storage size. There is no daily history, reset, export, migration, storage purge or synchronization to an external service. Configuration backup/reset behavior is unchanged; this independent storage key is not part of exported configuration.

There are no payloads, source/translated text, prompts, URLs, headers, provider/model identifiers, keys, tokens, credentials, error messages or per-request IDs in this store or its logging. The observer receives only two fixed enum values. BYOS attribution travels separately from the strict invocation payload and is never included in its upstream body.

The background is the single writer. A short serialized persistence chain combines pending increments and writes a complete aggregate. Failed writes retain pending increments for the next flush; a snapshot/refresh retries them. Invalid, unknown-version or overflowing stored values are preserved and reported as unavailable instead of replaced with zero. A failed flush sets an incomplete-warning flag for the current worker session. Reads flush previously queued writes before reporting totals.

Persistence never delays provider dispatch, awaits completion, consumes streams or changes request/SDK retry settings. An abrupt worker termination or storage failure can lose an attempt before its aggregate write completes. There is no atomic transaction between network dispatch and browser storage. The page explicitly describes this limit; persisted totals are resumed, but this is not a billing ledger. A worker lost before writing cannot leave a reliable per-event warning without adding a request journal, which is outside this small aggregate-only scope.

## Prepared merge gate

Per AGENTS.md, regression suites are **not run** during implementation, commits, pushes or PR creation. All local validation uses `SKIP_FREE_API=true`; no live translation service, API key or BYOS account is required.

New/updated coverage is prepared for aggregate concurrency and restart, failure recovery and future-data preservation, actual SDK retry transport, mixed/homogeneous batch attribution, stream/cancellation behavior, BYOS resend versus refresh/model requests, feature labels outside upstream payloads, and dashboard refresh/unknown/incomplete states. Existing translation-provider snapshots, caches, queue cancellation, stream protection and BYOS regression suites remain part of the final gate.

Immediately before an owner-approved merge, in a resource-checked environment with the pinned candidate:

```sh
SKIP_FREE_API=true NODE_OPTIONS=--max-old-space-size=3072 pnpm test --maxWorkers=2 --no-file-parallelism
```

Then run the relevant static checks and browser builds on that final candidate. Pro review, installed-browser input/demo, CI assessment and explicit confirmation immediately before merge are coordinated by the parent task. A build is not evidence of installed-browser behavior or successful regression execution.
