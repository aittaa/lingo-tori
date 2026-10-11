# Contributing to LingoTori

New contributions to this independent fork are accepted under the existing GNU GPLv3 license. Preserve upstream copyright notices, attribution and Git history. This fork does not request a new commercial license grant to a third party as a condition of contribution.

The upstream contribution terms, including their historical commercial-license grant language, remain available in Git history. This policy applies to new LingoTori contributions and does not revoke or change historical grants or relicense existing code. The root LICENSE remains unchanged.

Use the versions declared in package.json and follow AGENTS.md. Prepare relevant checks during implementation, but run tests only immediately before merging each focused PR, with SKIP_FREE_API=true. Perform type, formatting and browser-build checks at that merge gate as appropriate. Add a changeset for user-visible extension changes.

## Manual merge validation

The `Validate before merge` workflow is manually dispatched for the candidate branch at the final PR merge gate. It does not run on pushes or PR updates. It installs the locked dependencies without lifecycle scripts, prepares WXT types, and checks formatting, types, offline tests and both browser builds with read-only repository permissions. Defining the workflow does not enable repository Actions or establish a successful CI run.
