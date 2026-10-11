# Validation guidance

Run tests only immediately before merging a PR. Use `SKIP_FREE_API=true` and avoid live translation services. Record the tested commit and commands, and distinguish PASS, FAIL and NOT RUN.

The historical upstream baseline is `ca8da8241883c9aff5862d15d045845a746c9a6b`; its recorded measurements and limitations are in [the footprint baseline](metrics/README.md). Those results do not establish correctness of later feature branches.

For code changes, select relevant regression tests, type checks and browser builds at the merge gate. Keep browser UI observations separate from synthetic tests. An OAuth login or model listing does not establish successful translation, refresh, revocation or account switching.

CI must be invoked as a merge gate rather than on every push or PR update. Do not claim a prepared workflow has run. Preserve user data and the GPL license when validating independent-core migrations.
