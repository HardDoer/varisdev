# Agent tool enhancements

Recorded 9 September 2026 from extended use of the background agent tools. These are requested improvements; implementation is pending.

## 1. Inspect and revise pending agent messages

### Observed behavior

- A worker queue reached 32 pending messages and rejected a current handoff.
- Obsolete review and build instructions arrived after newer work had resolved their issues.
- `agent_status` exposes the pending count, while `agent_send` appends another message. The public tools do not expose individual pending messages for inspection, replacement or removal.
- `agent_cancel` discards the queue by cancelling the agent. `agent_new_session` preserves queued messages. Neither provides a way to remove an obsolete instruction while retaining the active task.

See [the orchestrator](src/agents/orchestrator.ts), [agent tool definitions](src/tools/agents.ts) and [the agent documentation](README.md#agent-orchestration).

### Suggested behavior

- Give queued messages stable IDs, creation timestamps, sender identity and an optional task/artifact reference.
- Expose bounded queue inspection with message previews and explicit retrieval of a selected message.
- Allow pending messages to be removed or replaced without cancelling the active task or losing the agent conversation.
- Allow a new assignment to explicitly supersede selected pending instructions, including when the queue is full. Preserve unrelated messages and show which entries were replaced.
- Report whether an instruction is still pending or has already been delivered. Replacing a pending item must not imply that work already started has been undone.

This would reduce repeated context loading and obsolete task execution. Coordinators still need to send fewer, consolidated instructions.

## 2. Expose and manage pending session handovers

### Observed behavior

A later `session_new` call returned:

> A parent session handover is already pending.

The tool API exposes no way to inspect, update or cancel that pending request. The current workaround is to keep the project handover file current so the next session can read the latest state.

[Parent session code](src/tools/session-new.ts) schedules a command that waits for idle before switching sessions. Its instructions require the caller to finish the turn immediately. The observed pending response does not establish why a particular transition was delayed; repeated calls and incoming messages should be considered when investigating that behavior.

### Suggested behavior

- Return a handover request ID and expose its state: scheduled, waiting for idle, switching, completed, cancelled or failed.
- Show the source session, destination session when available, request time and a concise explanation of what is still pending.
- Allow the handover text to be replaced before dispatch to the destination. Confirm which revision the fresh session received.
- Allow cancellation before the transition commits, especially when the user subsequently asks to stop work.
- Return an explicit outcome if replacement or cancellation is too late; preserve the active session and agent attachment state consistently.
- Verify that incoming worker messages cannot indefinitely postpone an explicitly requested session change. Preserve and deliver them to the appropriate conversation after the transition.

Relevant integration code: [agent session transfer](src/agents/team.ts). A user should be able to distinguish a queued request from a completed session change without repeatedly submitting the whole handover.

## Workflow practices remain separate

Short task briefs, fewer acknowledgments, consolidated follow-ups, concise handovers, bounded file queries and resolving known fixture dependencies before a build are coordinator practices. They are recorded in the Game Studios workflow notes. The enhancements above improve visibility and recovery when a queue or handover becomes stale.
