---
name: commit
description: Commit and push the requested changes through the configured commit agent.
disable-model-invocation: true
---

# Commit and push

The `/commit` command is an explicit request to commit and push. Apply any additional user instructions, including the intended changes, commit message, and push destination.

## Delegate

Coordinate with active workers before delegating so the commit agent receives a stable set of changes. Use `agent_spawn` with the configuration arguments supplied by `/commit`; otherwise use `template="commit"` and `autoCleanup=true`. The `commit` agent configuration follows the normal agent overrides: builtin, global, repository, then workspace.

Supply a concise task with the intended changes, completed checks, and any requested commit message or push destination. Reference relevant files instead of copying repository instructions or conversation history. State explicitly that the task is to commit and push.

Collect the result with `agent_status` or `agent_wait` before reporting completion. An agent started with `autoCleanup=true` is disposed after finishing; its saved result and transcript paths remain available through `agent_status`.

Report the commit hashes, checks, push outcome, and any remaining changes or blockers.
