# Native local session handoff

The previous cloud-managed task is stopping at this checkpoint. Its command execution was verified on the server Mac, but this does **not** make it a native local project task. Do not restart its subordinate writers while a native local session owns this checkout.

## Exact workspace

- Repository: `/Users/hyeonkim-server/workspace/lingo-tori`
- Sidecar tooling and logs: `/Users/hyeonkim-server/workspace/lingo-tori-local`
- Current branch: `feat/independent-lingotori`
- Origin: `https://github.com/aittaa/lingo-tori.git`
- Upstream: `https://github.com/mengxi-ream/read-frog.git`
- Original baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`
- Planning: `docs/lingotori-plan`, commit `205ff9abb34f02299a330f95daf1ac86aa2b1e9a`, draft PR #9.
- Learning: `feat/local-learning`, commit `22cddd68`, draft PR #10 based on the planning branch.
- Companion: `feat/local-byos`, commit `94a28907`, draft PR #11 based on the learning branch.
- Extension source: `d1d083bd56ad137407102beceb113a2a4bf6aa15` on the current branch.
- Validation documentation and final artifact revision: `2336097fa662ff378938edc1aea4425b0896a122`.
- This handoff document is the only change after that artifact revision. Use `git log -1` for the handoff commit and `gh pr view feat/independent-lingotori --repo aittaa/lingo-tori` for the final draft PR.

No user source was reset, discarded or stashed. At handoff all source is committed; the final response verifies the clean worktree and pushed branch. Local historical branches/artifacts remain preserved. Old `read-frogextension-*.zip` files in `.output` are baseline evidence, not candidate deliverables.

## Validation already completed

- PASS: type-aware lint/type check, formatting and diff whitespace.
- PASS: complete Vitest suite, 332 files / 3,319 tests.
- PASS: 45 Node tests (32 companion, 13 learning/core/server/web), including isolated exports of the first two implementation commits.
- PASS: Chrome and Firefox MV3 builds, Firefox ZIP, source ZIP, changeset status, GPL hash preservation and generated-artifact inventory.
- Final failing checks: none.
- NOT RUN: installed-extension visual demo/native IndexedDB lifecycle, live BYOS login/token rotation/model eligibility/inference, hosted deployment, merge or release.
- Two independent reviewers closed the remaining BYOS cancellation and cross-client language-alias findings. Earlier failing logs are retained as history, not current unresolved results.

See [validation.md](validation.md), [metrics/after.json](metrics/after.json), sidecar `final-artifacts.json`, and sidecar `logs/final-*.log`. The Chrome output is 14,612,631 bytes versus 23,811,511 baseline (-38.63%); direct dependencies are 121 versus 134. These are packaging measurements, not runtime performance claims.

Candidate artifacts are `.output/chrome-mv3/`, `.output/firefox-mv3/`, `.output/lingotoriextension-1.50.3-firefox.zip`, and `.output/lingotoriextension-1.50.3-sources.zip`. They include GPL and attribution notices. The source archive predates only this handoff document.

## Workers and requested models

All workers returned completed/frozen before this handoff; there are no active subordinate writers. The previous task must not dispatch further work after the new local task begins.

Requested allocation: **GPT-6 Astra for orchestration and review; GPT-6.1 Sol for development**. Original development before the model handoff also used an explicit Astra configuration. Tools report model requests/configuration, not attested active runtime identity; do not claim otherwise. Changing a task model applies to a subsequent turn, not retroactively to an already executing turn.

## Desktop task association

Supported desktop metadata verified the local `lingo-tori` project ID as `bc3cac22-5ccf-42d7-810e-4af64462d2af`, pointing to the repository above. The prior task `01a12a0b-b13b-776d-b3d2-1b147df48010`, titled `Prepare LingoTori development workspace`, has `projectId: null`, host metadata `durable`, and task cwd `/Users/hyeonkim-server/Documents/Codex/2026-10-11/task`. It appears in Tasks rather than that local project.

The available `create_thread` API supports creating a **distinct** native project task with `target.type: project`, this project ID and `environment.type: local`, plus model `gpt-6-astra`. This route was not invoked here, so no new native task or transfer is claimed. Available tools do not expose in-place project reassignment/conversion for this task; `handoff_thread` cannot move the calling task and does not support cloud handoff. Codex application UI inspection was denied by the computer-use tool; no menu names or unsupported manual transfer procedure are asserted. No internal app databases or session files were accessed or changed.

## Resume instructions

1. Start or select a native local task under the existing `lingo-tori` desktop project, then verify its own project/host metadata and actual repository path before editing. Read this file, `AGENTS.md`, `docs/validation.md` and the relevant repository skills. Do not clone again, reset the checkout, or recreate issues/PRs.
2. Use `source ../lingo-tori-local/env.sh` from the repository. Node 26.11.1 and pnpm 12.10.1 are already prepared. Do not repeat installs or full tests unless changes or a concrete concern justify them.
3. Review the draft stack #9 → #10 → #11 → the integration draft. Issues #2–#8 already map all 12 requested cleanup/BYOS/README/footprint items; they remain open pending acceptance.
4. The next useful gate is a faithful installed-extension smoke test in a fresh, credential-free browser profile: settings migration, page/selection mock translation, offline save/review, native IndexedDB persistence and BYOS pairing UI. Do not bypass the earlier preview-server approval denial. Real BYOS sign-in/inference needs separate user authorization and availability checks.
5. Keep remote GitHub Actions disabled. Do not merge, deploy, release, call paid APIs, create live tokens, touch other projects/services, or broaden account access. Preserve GPL and upstream attribution. Do not delete retained marketing assets whose removal was denied without resolving that specific scope/provenance boundary.

No further implementation is requested by this handoff itself; continue only under the user's native local session instructions.
