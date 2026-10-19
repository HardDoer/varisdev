# Agent configuration cleanup and remembered approvals

- [ ] Remove inactive `request` metadata from agent configuration parsing, storage, tools, editor, examples, and documentation.
- [ ] Add approval choices: once, this conversation, and this agent in this workspace.
- [ ] Persist remembered approvals with exact operation scope; explicit deny rules always take precedence.
- [ ] Provide native Pi controls to review and revoke remembered approvals.
- [ ] Integrate approvals across main, attached, delegated, nested, and skill-command paths.
- [ ] Verify persistence, isolation, revocation, cancellation, and concurrent updates with bounded focused checks.
- [ ] Review affected native approval UI at compact sizes, supported zoom, and alternate themes.
- [ ] Run final TypeScript checks and lint, update documentation, and remove this plan.

## Handoff state

The checklist above has not been implemented yet. The latest request only created this plan; the current source remains the previously verified implementation. No background agents or checks are running.

- Remove the inactive agent-profile `request` field. Keep Pi's working provider/model configuration and provider extensions.
- Remembered approvals should be scoped to the conversation or the agent configuration within the canonical workspace. Explicit deny rules must always win. Include review and revocation controls using native Pi UI.
- The user accepted retaining existing global/repository instructions in attached terminal sessions. Do not strip those instructions as part of this work.
- Preserve the real, empty Default agent and saved profile snapshots.

## Verified baseline

- Main and desktop TypeScript checks, supported `npm run lint`, and `git diff --check` passed.
- Focused agent, configuration, permissions, native UI, and SDK integration checks passed. The final SDK query test verifies that approval and execution use the same file snapshot through nested calls, reload, and resume.
- Desktop UI suite and subsequent focused tests for the final native-widget changes passed. Real Pi widgets were reviewed at compact sizes and 150%/200% zoom; alternate themes were reviewed.
- `npm run desktop:build` passed during handoff.
- `npm pack --dry-run --ignore-scripts --json` passed. The package includes the new Default agent, commit skill, shell scanner, native session views, and agent configuration UI assets.
- A fresh installation and launch of the packaged release has not been verified. Native PowerShell testing was skipped on this Mac.

## Moving machines

- Transfer or commit the full working tree, including the new untracked source files, assets, tests, and this plan.
- Verification must use enforced process-tree timeouts per `AGENTS.md`. The previous timeout wrapper and screenshots were under `/tmp` and are not part of the repository.
- No commits, pushes, or publication were performed.
