# Agents and agent configurations

A workspace contains a main agent and any additional agents. The main agent is the large robot in the factory. Select an agent to open its conversation, send a prompt, stop its current work, or continue a retained conversation.

## Start a conversation

Every conversation has a selected agent. **Default** is selected automatically and adds no persona, workflow instructions, model preference, step limit, or permission rules. It preserves Pi's normal context, resources, tools, and settings. You can use Default for all work.

**New conversation** lets you choose another agent configuration. A name and initial message are optional; unnamed workspaces use the folder name. Set `default_agent` in Pi `settings.json` to choose a visible primary or all-mode agent automatically. An unavailable, hidden, disabled, or subagent-only choice falls back to Default. If an override makes Default unsuitable, the empty built-in Default remains available.

Resumed conversations retain their selected profile snapshot. Older and attached Pi conversations without a saved selection receive the neutral Default rather than a newly configured persona. The selected configuration appears beside the composer and in session settings.

Every new agent has its own message history. Starting one does not copy the calling conversation or other agents' messages. Resuming an agent retains its own history. Additional agents share workspace files and can exchange messages explicitly.

## Other agents

Build and Plan are optional primary agents. General and Explore are optional subagents. Plan and Explore provide restricted tools for investigation; General can work broadly but cannot delegate further. Their instructions apply only when selected.

[Example configurations](../examples/agents/README.md) can be copied and customized. They are outside the configuration discovery paths and add nothing to the default prompt.

The bundled `commit` configuration belongs to the explicitly invoked `/commit` skill. Its instructions and skill description stay out of ordinary prompts and agent catalogs. It remains available in the configuration editor for customization.

## Storage and scopes

Open **Agent configurations** to create or edit Markdown profiles. Higher scopes override fields from lower scopes:

1. **Workspace (this machine)** applies to this project on the current machine.
2. **Repository** can be shared through version control.
3. **Global** is available across projects.
4. **Built-in** supplies Default, the other standard agents, and the commit skill's fallback configuration.

Files are stored at:

- Global: `getAgentDir()/agents/**/*.md`, normally `~/.varisdev/agent/agents/**/*.md`.
- Repository: `.varisdev/agents/**/*.md` in each directory from the repository root through the current working directory. Closer definitions override earlier ones.
- Workspace: `getAgentDir()/workspaces/<project-hash>/agents/**/*.md`.

**Menu → Open workspace configuration** opens the personal workspace directory. It is associated with the canonical repository or worktree root, so project subdirectories and symlink aliases share it. Separate worktrees and moved repositories have separate workspace configuration. `VARISDEV_SETTINGS_DIR` changes the global settings directory.

A file's relative path supplies its ID: `team/reviewer.md` becomes `team/reviewer`. Each path component must be a lowercase filename slug. A scoped reference such as `repository:team/reviewer` resolves through that scope, excluding higher overrides.

## Markdown format

Frontmatter configures the profile. A nonempty Markdown body supplies its system instructions once, replacing the usual system-prompt base while retaining the selected context scope.

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
- `mode` is `primary` for new workspace conversations, `subagent` for delegated launches, or `all` for both. New custom profiles default to `primary`. Retained agents remain directly promptable in every mode.
- `context` is `workspace` or `task`, defaulting to `workspace`.
- `model` supplies a delegated agent's model preference as `provider/model`. A recognized suffix such as `#high` supplies `thinkingLevel`; arbitrary provider variants are not supported by this shorthand. Primary conversations select their model separately.
- `thinkingLevel` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `hidden: true` omits the profile from ordinary choosers and catalogs. Explicit references can still use it.
- `disabled: true` prevents new launches from that profile.
- `color` is a six-digit hex color.
- `steps` limits model turns per user request. The final allowed turn has no tools and requests a textual summary. Omit it for no profile step limit.
- `permissions` contains ordered `{action, resource, effect}` rules, with effects `allow`, `ask`, or `deny`.
- `request` can retain `headers` and JSON `body` maps. These merge by key and are not sent to providers. Configure active request options through Pi's model/provider settings.

Later scalar values replace earlier values. An empty body inherits lower-scope instructions. Permission lists append in scope order; the last matching rule wins. Shared `permissions` in Pi `settings.json` load from global settings, repository ancestors, then workspace settings, before profile-specific rules. Unmatched actions retain Pi's normal allowed behavior.

Common actions include `shell`, `edit`, `subagent`, `read`, `glob`, `list`, `grep`, `webfetch`, `skill`, `execute`, and `external_directory`. Actions and resources support whole-value `*` and `?` wildcards. Subagent rules use the configuration's unscoped ID, including `default` for implicit launches. `grep` matches the requested regular expression. Filesystem rules use canonical paths and expand leading `~` or `$HOME`; paths within the active folder or its worktree are internal. Code Mode uses `execute`, while nested calls still check their own permissions.

Permissions are checked when tools execute, including nested and deferred calls. Shell rules check parsed command components, including pipelines and substitutions, and infer static filesystem paths. A trailing ` *` also matches the command without arguments. Restricted shell calls are limited to 16 KiB of source; malformed or excessively nested syntax returns a scanner error. Dynamic filenames remain subject to the command rules. File query tools check the actual matched files and execute that approved selection. Configuration reads check their contributing files and return the approved snapshot. `ask` requests confirmation through the owning workspace. Each approval applies to the pending request. Tools wholly denied by the profile and denied skill descriptions are omitted from model declarations. Explicit skill commands and reads of discovered skill files also check skill permissions.

Primary conversations use Pi's selected model and reasoning independently of the agent profile. Delegated agents inherit omitted values from their caller. Existing conversations retain their saved effective profile snapshot; model and reasoning controls remain editable. Legacy snapshots acquire shared permission rules once when migrated.

### Context scope and token costs

`context: workspace` uses applicable project instructions and normal resource discovery. This includes configured `AGENTS.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md` files. Skill descriptions are available normally; skill and prompt bodies enter the conversation when invoked.

For conversations created by VarisDev, `context: task` omits automatic instruction files and skill/prompt discovery. Profile instructions, explicit instructions, explicitly selected resources, tools, and providers remain available. `agent_spawn.context` can override the profile's scope for that launch. Neither scope copies another conversation's history.

An attached native Pi session has already loaded its instructions. Its task profile can filter automatic skill metadata, but Pi's combined context and appended instructions do not retain enough source information to remove automatic instructions while preserving explicit ones. Those instruction sections remain in attached sessions.

Repeated instruction-file sources and identical appended blocks are deduplicated. Automatic agent catalogs contain at most 16 short descriptions. Configuration management is available through Pi's `tool_search`; configuration bodies are returned only by `get`. Pi's search helpers can expose tool metadata even when execution is denied. Listings default to 20 entries with pagination, and save/spawn operations return short acknowledgements.

Malformed files are omitted and reported with their scope and path. Invalid shared permission settings prevent profile resolution. VarisDev does not replace malformed files, directories, or symbolic links through the configuration editor.
