# Independent local learning v1

The learning core and server are newly authored and do not import Read Frog contract, definitions or implementation packages. The repository retains its existing GPL license. The extension can use the browser-safe `packages/learning-core/index.mjs` directly; adjacent TypeScript declarations describe its DTOs. This is an intentionally simple, versioned interval scheduler, not FSRS or a claim of scientific optimization.

## Run a personal server

Use Node 22.13+ with built-in `node:sqlite` (validated on Node 26.11.1). No package installation is required. Explicitly configure `LINGOTORI_SYNC_SECRET` to your own secret of at least 24 characters through your preferred environment mechanism, then run:

```sh
node apps/learning-server/server.mjs
```

No secret is generated, printed, shipped, or read from a credential store. Open `http://127.0.0.1:4317` and enter that secret. The public HTML is only an unlock shell; all learning data APIs require the secret. The browser holds it in memory until lock/reload. No cookies or localStorage credentials are used. The server always binds `127.0.0.1`; this is a single-user local service, not production hosted authentication. Local machine administrators remain trusted. Database files and SQLite sidecars use owner-only permissions (0600). Database directories must be owned by the current OS user and not writable by other users; database and sidecar symlinks or hard links are rejected. Protect exported files with OS permissions and disk encryption.

Optional environment settings: `LINGOTORI_PORT` (default 4317), `LINGOTORI_DB_PATH` (default `./lingotori-learning.sqlite`), `LINGOTORI_ACCOUNT_ID` (default `local`, server-side namespace), and `LINGOTORI_EXTENSION_ORIGINS` (comma-separated exact `chrome-extension://ID` or `moz-extension://ID` origins). Default cross-origin requests are denied. Do not expose this HTTP service to a network or reverse proxy without a separate security design. The extension backend remains optional.

## Data and synchronization

State: `{schemaVersion:1, notes:[], cards:[], reviews:[]}`. Notes contain `id, term, meaning, context, language, sourceUrl, updatedAt`. Reviews contain `id, cardId, rating, reviewedAt`. IDs are stable client identifiers (review UUIDs; extension note IDs hash normalized term and language); times are UTC epoch milliseconds. Rating is `again`, `hard`, `good` or `easy`. Card IDs equal note IDs. `cards` are derived and rebuilt, never trusted as imported scheduling authority. The scheduler is `simple-v1`: Again schedules ten minutes, Hard uses at least one day and 1.2× the previous interval, Good at least one day and 2×, Easy at least three days and 3×; intervals cap at 36,500 days.

`saveNote`, `reviewCard`, and `mergeStates` return new states without changing inputs. Notes resolve by highest `updatedAt`, then canonical normalized JSON lexical order. Reviews are an immutable event set: repeating the same ID and payload is a no-op; changing payload for an existing ID rejects the whole merge. Events replay in `(reviewedAt,id)` order. Concurrent reviews both count. Clock correctness is the user's responsibility. Unknown note references reject atomically. No delete/tombstone API exists in v1. Import merges; it does not replace or erase existing history.

`GET /api/state` returns `{state}`. `POST /api/sync` accepts exactly `{state}` and returns the merged `{state}`. Both use `Authorization: Bearer <configured secret>`. Namespace derives solely from server configuration, never client account IDs. SQLite transactions make saves durable and atomic. Replaying a request after lost connectivity is safe. Clients should preserve pending events locally and retry with the same IDs. UI actions are saved only after successful server response. A failed save stays in session memory and offers a retry using the same event IDs; export includes that pending state. Reloading before retry/export loses pending data. This web UI is not an offline PWA. Export/import uses the same schema and contains no configured secret.

Notes reject unknown fields. Source URLs allow only HTTP(S) without userinfo, query or fragment; clients must strip these before saving. Never put provider API keys, BYOS tokens or sync secrets into vocabulary text or exports. Arbitrary prose is not a secret detection system. There are limits of 10,000 notes, 100,000 reviews and 5 MB per sync/import request and per persisted state. State-wide sync is for modest personal collections; paging, deletion, multi-user login, rate limiting, encrypted storage, backup rotation and production deployment are future work.

## Validation

```sh
node --test packages/learning-core/core.node-test.mjs apps/learning-server/*.node-test.mjs
```

Tests use non-secret fixture credentials, a temporary SQLite directory removed at completion, and an ephemeral loopback listener. They cover deterministic replay, idempotency, conflict handling, unsafe input, durable reopen, namespace isolation, authentication and origin rejection. No paid APIs or external network calls are used. The responsive web UI has EN/KO/JA copy, reveal/rate practice and JSON export/import; automated real-browser visual QA is not included.

## Extension offline learning

The extension's `study.html` page provides local vocabulary, due counts, reveal/rate
practice, and JSON import/export in English, Korean, and Japanese. The selection
action saves vocabulary without any account or running server. The background is
the sole writer to the extension-origin IndexedDB database `lingotori-learning`,
using `state-v1` and `sync-v1` records. Both clients share the NFC-normalized term/canonical source-language SHA-256 identity policy; ISO language aliases such as en/eng, ko/kor and ja/jpn converge through Intl.Locale, and Chinese traditional-script tags remain distinct; updating an imported matching note retains its existing ID and review history. The language field identifies the vocabulary source language, with `und` for unknown. Success is reported only after the database
write completes. Same-term, same-language saves update one note, retaining review
history; new note identity is SHA-256 of the NFC-normalized trimmed term and canonical source-language code. ISO aliases converge, while traditional Chinese remains distinct; matching imported records retain their existing IDs.
This intentionally combines repeated captures of that term, including different
source pages; distinct senses need distinct term text in v1.

Only the exact trusted extension study page may read all learning state, review,
import, configure synchronization, or synchronize. Content scripts can save notes,
read aggregate counts, and open the study page. Optional sync credentials remain
in extension-origin IndexedDB and are never returned by the message API. They are
not OS-encrypted secrets and trusted extension code remains part of the trust
boundary. Export contains only learning state. Source URLs lose credentials, query
strings, and fragments before validation.

Manual extension sync accepts `http://127.0.0.1:<port>` origins only, matching the
server's binding and Host policy. Set the server's exact allowed extension origin
(the study page displays it) and enter the same 24–1024-character secret in the
private study page. Redirects are refused; requests time out after 15 seconds.
Failed synchronization leaves locally persisted notes and events available to
retry. There is no automatic background sync, delete/tombstone operation, or
account authentication in this local-only v1.

Offline extension tests use a durable file-backed persistence adapter to test
service restart/retry behavior and mocked HTTP responses, plus sender-boundary
and save-hook tests. They do not substitute for an installed-extension IndexedDB
or visual browser test.

Practice queues refresh as time passes and on focus in the web client. A failed extension review remains pinned to its original card and event ID; retry it before saving, importing, or syncing other changes.
