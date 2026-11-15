# Agents and agent configurations

Every workspace session has exactly one **Main agent**, the fixed conversation starter shown as the large robot in the factory. Main does not use an agent configuration. Additional agents keep their configured **Primary agent** or **Subagent** roles. Select an agent to inspect its conversation, context, and current work. Additional agents created from `primary` or `all` configurations accept direct prompts; subagents receive work through their parent.

## Start a conversation

**New conversation** starts the session's Main agent. Choose a saved folder from **Recent workspaces** or use **Choose folder** to work elsewhere. Recent workspaces use the same history as the welcome screen; folders that no longer exist are omitted. A conversation name and first message are optional, and unnamed workspaces use the folder name. The dialog has no agent configuration picker.

Main uses Pi's normal workspace context, resources, tools, and session model and thinking settings. Resumed sessions keep the same Main transcript and restore additional agents with their saved configurations. Main stays available until the workspace is closed and cannot be closed separately.

Every agent has its own message history. Starting an additional agent does not copy the calling conversation or other agents' messages. Resuming an agent retains its own history. Additional agents share workspace files and can exchange messages explicitly.

**Menu → Resume session** restores the Main transcript and the workspace's retained additional agents, conversations, results, recorded file changes, and inbox messages. Retained agents can continue from their saved conversations. Work interrupted by an app exit appears as stopped and waits for an explicit follow-up. Older saved workspaces recover available agent transcripts for viewing; those imported agents cannot continue because their launch settings were not saved.

Finished agent history expires after **7 days without use** by default. Set a period from **1–365 days** in [Agent settings](configuration.md#agent-settings). Viewing an agent's conversation, reading its result, or continuing it resets the inactivity period. Active agents, including running and queued work, the Main session transcript, and the last Primary agent's history are protected. Expired history is permanently deleted rather than archived.

Use **Actions → Close agent**, or right-click an additional agent and choose **Close agent**, to close its conversation. Main stays available even after every additional agent is closed. **Close workspace** ends the whole session and stops its agents.

## Other agents

Agent configurations apply to additional agents. In Main, start an agent with a configuration ID at the beginning of a message, for example `@explore Find where cancellation is handled` or `@build Implement the change`. Each invocation starts an additional agent in the same workspace. The parent agent can continue an existing subagent with `agent_send` and its ID. For nested configuration IDs, use `@agent:team/reviewer Your task`. Quote names containing spaces, such as `@"Review Agent" Check the changes` or `@agent:"Team/Review Agent" Check the changes`; the mention picker inserts the appropriate form.

VarisDev delivers completed results and errors automatically to the conversation that initiated the work. The caller and workers can continue in parallel. VarisDev waits only if the caller reaches the end of its run with outstanding work, then resumes it when that work settles. An agent waiting for nested agents temporarily releases its concurrency slot. Normal use does not require polling `agent_status` or calling `agent_wait`. Sending a message to an already running agent is messaging only and does not add another result dependency.

Build and Plan are optional primary agents. General and Explore are optional subagents. Plan and Explore provide restricted tools for investigation; General can work broadly but cannot delegate further. Their instructions apply only when selected.

[Example configurations](../examples/agents/README.md) can be copied and customized.

## Storage and scopes

Open **Menu → Agent settings → Agent configurations** to create or edit Markdown profiles. Higher scopes override fields from lower scopes:

1. **Workspace (this machine)** applies to this project on the current machine.
2. **Repository** can be shared through version control.
3. **Global** is available across projects.
4. **Built-in** supplies Default and the other standard agents.

Files are stored at:

- Global: `<settings-directory>/agents/**/*.md`, normally `~/.varisdev/agent/agents/**/*.md`.
- Repository: `.varisdev/agents/**/*.md` in each directory from the repository root through the current working directory. Closer definitions override earlier ones.
- Workspace: `<settings-directory>/workspaces/<project-hash>/agents/**/*.md`.

**Menu → Open workspace configuration** opens the personal workspace directory. It is associated with the canonical repository or worktree root, so project subdirectories and symlink aliases share it. Separate worktrees and moved repositories have separate workspace configuration. `VARISDEV_SETTINGS_DIR` changes the global settings directory.

A file's relative path supplies its ID: `team/reviewer.md` becomes `team/reviewer`, and `sf-agent.test.md` becomes `sf-agent.test`. Names use ordinary filesystem rules and preserve spaces, punctuation, uppercase letters, and Unicode. A scoped reference such as `repository:team/reviewer` resolves through that scope, excluding higher overrides.

## Markdown format

Frontmatter configures the profile. A nonempty Markdown body replaces the default system instructions; the selected context files still apply.

```markdown
---
name: Reviewer
description: Reviews changes for concrete defects
mode: all
color: '#ff6b6b'
steps: 8
permissions:
  - action: edit
    resource: '*'
    effect: deny
  - action: shell
    resource: '*'
    effect: deny
---

Review the requested changes. Report concrete issues with file references.
```

All fields are optional:

- `name` defaults to the ID.
- `description` explains when the agent is useful.
- `mode` is `primary` for an additional conversation that accepts direct prompts, `subagent` for delegated launches, or `all` for both. New custom profiles default to `primary`. Only primary and all-mode additional agents accept direct user prompts; a subagent's parent can continue or steer its retained session.
- `context` is `workspace` or `task`, defaulting to `workspace`.
- `model` pins a delegated agent to `provider/model`, overriding launch arguments and Agent settings selections. Omit it to inherit the caller's model or accept an allowed launch choice. In the editor, this default appears as **Use agent model settings** when agent models are selected, otherwise **Inherit**. A recognized suffix such as `#high` supplies `thinkingLevel`; arbitrary provider variants are not supported by this shorthand. Main and other primary conversations select their model separately.
- `thinkingLevel` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `hidden: true` omits the profile from ordinary choosers and catalogs. Explicit references can still use it.
- `disabled: true` prevents new launches from that profile.
- `color` is a six-digit hex color.
- `steps` limits model turns per user request. The final allowed turn has no tools and requests a textual summary. Omit it for no profile step limit.
- `permissions` contains ordered `{action, resource, effect}` rules, with effects `allow`, `ask`, or `deny`.

Later scalar values replace earlier values. An empty body inherits lower-scope instructions. Permission lists append in scope order; the last matching rule wins. Shared `permissions` in Pi `settings.json` load from global settings, repository ancestors, then workspace settings, before profile-specific rules. Unmatched actions retain Pi's normal allowed behavior.

Common actions include `shell`, `edit`, `subagent`, `read`, `glob`, `list`, `grep`, `webfetch`, `skill`, `execute`, and `external_directory`. Actions and resources support whole-value `*` and `?` wildcards. Subagent rules use the configuration's unscoped ID, including `default` for implicit launches. `grep` matches the requested regular expression. Filesystem rules use canonical paths and expand leading `~` or `$HOME`; paths within the active folder or its worktree are internal. Code Mode uses `execute`, while nested calls still check their own permissions.

Permissions are checked when tools run, including nested and deferred calls. Shell rules apply to commands in pipelines and substitutions and to explicit file paths. A trailing ` *` also matches the command without arguments. Restricted shell calls are limited to 16 KiB of source. `ask` requests approval in the owning workspace. Tools and skills that are fully denied are unavailable to the agent, though tool metadata may still appear in search results. Skill permissions also apply to explicit skill commands and reads.

Main uses Pi's selected model and reasoning. Additional agents inherit omitted values from their caller, subject to Agent settings selections. Configuration model pins remain fixed; other model and reasoning controls remain editable.

### Remembered approvals

When an operation requires approval, choose:

- **Allow once** for the pending operation.
- **Allow this conversation** to remember it for the current agent conversation, including when resumed.
- **Allow this agent in this workspace** to remember it for that configuration ID in the canonical working folder.
- **Deny** to block the operation.

Remembered approvals match the exact tool, action, resource, and input. An effective `deny` rule takes precedence. Each delegated agent has its own conversation scope; sharing the parent's approval dialog does not share its conversation grants.

Use **Menu → Approvals** or `/approvals` to inspect and revoke grants. These controls also remain available for subagents. Grants are stored in `<settings-directory>/varisdev/approvals.json`.

### Context scope and token costs

`context: workspace` uses applicable project instructions and normal resource discovery. This includes configured `AGENTS.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md` files. Skill descriptions are available normally; skill and prompt bodies enter the conversation when invoked.

For conversations created by VarisDev, `context: task` omits automatic instruction files and skill/prompt discovery. Profile instructions, explicit instructions, explicitly selected resources, tools, and providers remain available. `agent_spawn.context` can override the profile's scope for that launch. Neither scope copies another conversation's history.

For attached Pi sessions, `context: task` cannot remove instruction files that Pi has already loaded.

Malformed files are omitted and reported with their scope and path. Invalid shared permission settings prevent profile resolution. VarisDev does not replace malformed files, directories, or symbolic links through the configuration editor.
