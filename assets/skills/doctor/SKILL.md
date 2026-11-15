---
name: doctor
description: Check VarisDev setup, extensions, instruction quality, permissions, and session usage; report findings and propose repairs before applying them. Use prompt-audit for a focused audit of repository instructions, skills, and configuration.
---

# Doctor

Provide the interactive checkup described by [Claude Code's doctor skill](https://code.claude.com/docs/en/skills#check-your-setup-with-doctor), using VarisDev's available features and working across model providers.

## Choose the mode

- `/skill:doctor`: run the setup checkup below, including the repository's instructions and working conventions.
- `/skill:doctor prompt-audit`: run the focused instruction audit below instead of the setup snapshot. This is a separate mode, not an alias for the full checkup.
- Further arguments can focus either mode on a reported issue, directory, file, or workflow.

Start the read-only investigation immediately. Complete the evidence gathering and prepare concrete repairs before requesting approval. Review session tokens and context usage; subscription plans, quotas, and plan-specific recommendations are outside this skill.

## Setup checkup

### Collect the local evidence

Run the helper beside **this loaded SKILL.md**, using its actual absolute location:

```text
node "<directory containing this SKILL.md>/scripts/diagnose.mjs" --project "<active session working directory>"
```

The helper works from an installed package or source checkout on Node 24+. It has a 12 second deadline, starts no child processes, reads bounded regular files, and returns JSON. Run it with an enforced process deadline as well. For additional command checks, use the shipped `runCommand` from `<installationRoot>/scripts/test-installer.mjs` with an explicit `timeoutMs`; it cleans up child processes on timeout. Use the helper's reported `installationRoot` and configuration paths rather than assuming the active project contains VarisDev.

Read `checks` and `limits`, including unknown results, omitted sections, and deadlines. Partial output does not establish that the setup is healthy. The snapshot cannot inspect the live session; combine it with the available conversation, loaded resources, and existing application interfaces described below. Report missing evidence precisely.

Keep credentials out of findings and artifacts. Report environment variable names, presence, and sources; never print values, OAuth tokens, credential commands, MCP headers/arguments, or credential-bearing URLs. Do not evaluate command-backed credentials or start plugins, hooks, or servers solely to diagnose them.

### Installation and configuration

- Compare the running application and Node versions, packaged dependencies, required runtime files, PATH candidates, and update activation state. Investigate duplicate or leftover installs using the intended installation and actual launcher. Package metadata does not prove that another executable on PATH has the same version. Desktop and terminal launches may use different environments.
- Check malformed settings and missing referenced resources using their actual scopes. VarisDev's default agent directory is `~/.varisdev/agent`; `VARISDEV_SETTINGS_DIR` can select another location. Prefer the helper's resolved paths. Settings generally apply from global, trusted repository, trusted current-folder, then personal workspace; nested objects merge and resource/permission rules have their own accumulation rules. A differing value across scopes is not itself a defect.
- Check saved environment overrides separately from inherited values. An explicitly saved value, including an empty string, takes precedence; removing it restores environment fallback. The helper uses the app's bound settings-file location, since inherited directory variables may already contain saved overrides. If an older launch cannot supply that location, restart the updated app before retrying the affected checks. Use **Menu → Environment** in the affected launch for authoritative source labels. Reading fallback must not persist it. Do not source shell startup files again as a diagnostic.
- Check update locks, activation pointers, build files, and permissions without deleting or repairing them during diagnosis. A lock does not prove an updater is stuck; a pointer does not prove which runtime the session uses. Use **Updates → Check for updates** and the affected app's update status when accessible to establish the latest version and restart state. Offline package metadata cannot establish whether an update is available.
- Check authentication presence when it explains a reported problem. Preserve each plugin's authentication contract; a saved LLM OAuth login does not supply a plugin API key. Do not refresh credentials, make provider calls, or initiate sign-in merely to check presence.

### Extensions and context cost

- Inspect registered and loaded skills, plugins, MCP servers, and hooks using the snapshot, **Skills & commands** resource diagnostics, and available session history. Compare their observed use with measured context cost. Distinguish registered, enabled, loaded, and used resources. No use observed in this conversation does not establish that a resource is globally unused.
- Identify missing paths, shadowed resources, malformed MCP entries, namespace collisions, disabled servers, and missing referenced environment names with their scope. Do not import or execute user extensions to inspect them.
- Use the affected session's existing `/mcp` interface or available application state for live MCP status. Do not execute slash commands through a shell. `varisdev mcp list` connects servers, so it is not a passive configuration check. If no live interface is available, report connection state as unverified.
- Flag slow hooks only with timings or repeated observed delay attributable to that hook. State when timings or context costs are unavailable. Offer disabling, removing, or narrowing a specific resource only when the evidence supports the expected benefit.

### Instruction quality

Inspect the repository's `AGENTS.md` and other applicable instructions using the scope rules in **Instruction audit** below. In the setup checkup, emphasize:

- Local or personal copies that duplicate or have drifted from checked-in guidance.
- Checked-in content that merely repeats facts readily discoverable from the codebase.
- Repeated or lengthy always-loaded guidance that could become a focused skill or referenced guide.

Prepare exact edits and destinations for worthwhile migrations. Keep stable working conventions and explicit pointers where needed. Nested instruction files do not acquire Claude Code's on-demand loading behavior in VarisDev merely by being created.

### Permissions

Review the applicable shared permission rules, selected agent profile, available approval requests, and observed denials. **Menu → Approvals** and `/approvals` list remembered grants; they do not retain denial history. Identify repeated approval friction with concrete examples from the available conversation and propose narrow existing permission rules or remembered approvals for actions the user wants.

Use VarisDev's actual permission actions and scopes. Do not invent an automatic permission mode or claim access to denial frequencies unavailable in the session. A denied action is evidence to discuss, not authorization to allow it. Present any permission change for approval with its exact scope and effect.

### Session usage

Use the selected conversation's **Context** and **Tokens** views, `/session` when available, and observed conversation/tool activity. These are session interfaces, not shell commands. Report available context occupancy, model context limit, token counts, and reported cost with their source. Context occupancy and costs calculated from configured model rates are estimates. Tokens totals for the current branch can differ from `/session` totals that include other recorded entries.

Distinguish loaded instructions, skill advertisements, invoked skill bodies, tool/MCP schemas, and retained conversation. Do not convert disk byte counts into exact token costs or assume every discovered skill body is loaded. Suggest trimming duplicated guidance, narrowing expensive resources, compacting a large conversation, or changing to a supported model/thinking level only when the observations justify it. If live usage is inaccessible, complete the other checks and identify the missing session evidence.

## Instruction audit

For `prompt-audit`, skip the setup snapshot and concentrate on outdated, conflicting, duplicated, or unclear instructions in the current repository and relevant configuration. Use the active working directory and repository or worktree root as the scope; the skill's installation directory is not the audit target.

- Inventory root and nested `AGENTS.md` files and discovered `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, agent profiles, and `SKILL.md` files. Read applicable contributing/workflow guides and instruction-related configuration. Include relevant untracked local files. Exclude dependencies, generated output, vendored code, and unrelated repositories unless explicitly relevant.
- Include ancestor, personal, workspace, or selected agent guidance already supplied in the active context when it affects the repository. Follow specific references as needed; do not scan the user's home directory for configuration.
- Map instructions to their actual scope and distinguish active sources from files merely present on disk. VarisDev/Pi selects the first readable instruction file in each directory in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Inspect shadowed files for drift without treating their differences as active conflicts.
- Automatic repository context follows the session working directory's ancestry. Reading a file in a child directory does not automatically load that directory's instructions. If moving guidance into a nested file, retain a reference from a source the agent loads. Skill bodies are normally loaded on invocation/read; their metadata can be advertised separately.
- Compare applicable rules for incompatible review, testing, approval, commit, and release requirements. Check precedence and scope before claiming a conflict; deliberate overrides and personal preferences are not defects.
- Verify paths, commands, tooling, configuration keys, architecture claims, and workflow entry points against current manifests, CI, automation, and representative project files. Report a missing convention only when it leaves a concrete decision unclear or causes observed friction.
- Check skills' descriptions against their bodies, referenced tools, and available capabilities. Identify obsolete options, incorrect path assumptions, and contradictory or recursive workflows.
- Identify duplication and unnecessary always-loaded text. Propose precise consolidations or moves into appropriate skills, scoped instructions, or linked guides while preserving meaningful local differences and discoverability.

Read only the project facts needed to support each finding. For large repositories, group by project area and state any uninspected scope. Inspect command definitions before running checks; use bounded existing checks only when needed to resolve a finding. Do not execute obsolete commands, installers, deployments, or release actions just to demonstrate a problem.

## Findings, confirmation, and fixes

Present a concise report grouped by checkup area, or by instruction source for `prompt-audit`. Include what was inspected and any material limits. For each actionable finding give the source/rule, supporting evidence, practical effect, and exact proposed edit or existing application action. Include the destination and discoverable reference for moved guidance. If no actionable issues were found, say so without inventing cleanup work.

Report findings first, then ask which proposed fixes to apply. A checkup or audit invocation alone authorizes inspection and proposals. If the user already explicitly authorized a particular repair, carry it out within that scope without asking for the same authorization again. Preserve unrelated files, settings, and user changes. After approved repairs, rerun only the relevant bounded checks and report what changed and what remains unresolved.
