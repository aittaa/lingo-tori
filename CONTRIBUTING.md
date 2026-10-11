# Contributing to LingoTori

New contributions to this independent fork are accepted under the existing GNU GPLv3 license. Preserve upstream copyright notices, attribution and Git history. This fork does not request a new commercial license grant to a third party as a condition of contribution.

The upstream contribution terms, including their historical commercial-license grant language, remain available in Git history. This policy applies to new LingoTori contributions and does not revoke or change historical grants or relicense existing code. The root LICENSE remains unchanged.

Use the versions declared in package.json and follow AGENTS.md. Prepare relevant checks during implementation, but run tests only immediately before merging each focused PR, with SKIP_FREE_API=true. Perform type, formatting and browser-build checks at that merge gate as appropriate. Add a changeset for user-visible extension changes.

## Manual merge validation

The `Validate before merge` workflow is an optional manual gate immediately before a PR merge. It does not run on pushes or PR updates. It installs locked dependencies without lifecycle scripts, prepares WXT types, and checks formatting, types, offline tests and both browser builds with `SKIP_FREE_API=true`, pinned actions and read-only repository permissions. Defining the workflow does not enable Actions or establish a successful run. Local merge checks remain available while Actions are disabled.

### Bootstrap and approval

Repository Actions deliberately remain disabled. Obtain explicit repository-owner approval before enabling Actions, and separate explicit approval for each dispatch or rerun. Approval to publish or review a PR does not authorize either action. Review all workflows that would become active before enabling Actions; the manual trigger in this file does not disable other workflows. Obtain explicit user confirmation immediately before every merge.

GitHub requires a `workflow_dispatch` workflow to exist on the repository's default branch before it can be used. The initial default-branch snapshot has no `.github/workflows/ci.yml`, so this gate cannot validate its own initial bootstrap through a candidate-branch dispatch. Review and validate the initial workflow offline, complete the applicable local merge checks, and obtain explicit approval to land the trusted policy on the default branch while Actions remain disabled. This is a bootstrap prerequisite, not evidence of a failed CI run. See [GitHub's manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

### Validate an immutable candidate

1. At the final merge gate, review the workflow policy on the default branch (currently `main`) and the candidate's package scripts, build configuration, tests and dependencies. Record the PR's current full head commit SHA and obtain owner approval for that candidate and policy revision.
2. Dispatch `.github/workflows/ci.yml` with the default branch as the workflow ref and that full 40-character lowercase commit SHA as `candidate_sha`. The dispatch ref selects the workflow policy; the input selects the source to validate. Do not select the candidate branch or a tag as the workflow ref. See [GitHub's dispatch ref and inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
3. The trusted workflow rejects other dispatch refs and malformed SHAs before checkout, checks out the candidate from this repository, and verifies that `HEAD` exactly matches the input before executing package commands. It records the workflow ref, policy commit and candidate commit in the log and run summary.
4. Accept a run only after verifying its default-branch workflow ref, approved policy commit, exact candidate checkout and successful validation steps. Record the run URL and both commit SHAs in the PR's merge evidence. The run is associated with the policy revision; it does not automatically establish a required status check on the candidate commit. If the candidate changes, obtain new approval and validate the new SHA. If the default-branch policy changes before dispatch, review and approve the new policy first.

Dispatching on a candidate branch would let its workflow edits redefine or remove the validation steps, including the ref guard. The guard catches operator mistakes when using the reviewed policy; it cannot constrain a replacement workflow on another ref. Trust comes from selecting and verifying the approved default-branch policy, not from accepting any run with the same workflow name.

Candidate scripts and dependencies still execute code on the runner. Read-only repository permissions, disabled checkout credential persistence, `--ignore-scripts` during installation and `SKIP_FREE_API=true` do not create an untrusted-code sandbox or block all network access. Supply no provider credentials, repository secrets or privileged environments, and keep the hosted runner. The owner must review and approve the candidate before execution; this gate claims offline translation checks, not safe execution of arbitrary code. No artifacts are published, and no release or deployment is performed.
