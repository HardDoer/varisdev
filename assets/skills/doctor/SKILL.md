---
name: doctor
description: Diagnose VarisDev installation, settings, extensions, authentication, and context overhead; propose concrete repairs. Use prompt-audit to check instructions for outdated or conflicting guidance.
---

# VarisDev doctor

Give the user a setup checkup, then propose fixes you can apply. This follows the scope of [Claude Code’s doctor skill](https://code.claude.com/docs/en/skills#check-your-setup-with-doctor), adapted to VarisDev and Pi.

Use `/skill:doctor` for the checkup. With `prompt-audit` in the arguments, run the instruction audit below instead of the installation checkup. Other arguments can narrow the investigation to a reported symptom.

Start the authorized read-only work without asking the user to choose a category. This is an application setup and instruction check, not a project lint or code review.

## Local snapshot

Run the helper beside **this loaded SKILL.md**, using its actual absolute location. Do not assume that the project working directory contains VarisDev or that the app uses a default install prefix:

```text
node "<directory containing this SKILL.md>/scripts/diagnose.mjs" --project "<active session working directory>"
```

The helper works from an installed package or a source checkout on Node 24+. It has a 12 second deadline, starts no child processes, reads bounded regular files, and returns JSON. Run it with a process deadline as well. For any additional command checks, use the app’s shipped `runCommand` from `<application root>/scripts/test-installer.mjs` with an explicit `timeoutMs`; it terminates child processes on timeout. The application root is four directories above this helper and is reported as `installationRoot`. Keep checks inside the project and avoid writing diagnostic artifacts unless requested.

Read `checks` and `limits`, including every `unknown`, omitted section, or deadline. A failed helper is an incomplete checkup. Do not call the setup healthy from partial output. Never include environment values, API keys, OAuth tokens, credential commands, MCP headers or arguments, or credential-bearing URLs in the response. The helper deliberately omits parser errors and raw configuration values because they can contain secrets.

### Installation and updates

- Compare the application version, Node executable/version, packaged Pi/Electron/npm versions, required runtime files, and executable candidates in PATH order. Package metadata does not prove that a different executable on PATH has the same version. A desktop launch and a terminal launch can use different installations or environments.
- Investigate duplicate PATH targets and additional install candidates before calling them leftovers. Identify the intended installation and the launcher actually used. Do not run arbitrary PATH executables to learn their version.
- Review update activation candidates, missing build files, update locks, and directory permissions. A permission probe does not establish that an update will succeed. A lock alone does not establish that an updater is stuck; an activation pointer alone does not prove the active session uses that runtime. Never delete a lock or downloaded runtime merely because it exists.
- For the actual latest version and restart state, use **Updates → Check for updates** and the affected app’s update status when accessible. Alternatively, a bounded `varisdev update --check` can check the live release using the intended installation. The CLI startup may initialize/migrate application state, so use the app control for the read-only checkup when that side effect matters. Do not fetch releases with shell HTTP clients, run an update as a diagnostic, or claim that offline metadata proves the app is current. If neither live route is available, mark latest version and restart state unavailable.

### Settings and environment

Use the reported paths, not guessed Pi locations:

- Global settings, `auth.json`, and `models.json`: `~/.varisdev/agent/` by default. `VARISDEV_SETTINGS_DIR` selects a custom directory without appending `agent/`; the legacy flat `~/.varisdev` override maps to `~/.varisdev/agent`. Pi’s own directory overrides do not redirect VarisDev.
- Trusted repository settings: `<repository or worktree>/.varisdev/settings.json`, with a more specific current-folder `.varisdev/settings.json` when present.
- Personal workspace settings: `<agentDir>/workspaces/<hash of canonical repository/worktree path>/settings.json`. Use **Menu → Open workspace configuration** to inspect the actual scope. Worktrees and moved repositories have separate workspace directories.
- Preference precedence: global, trusted repository, trusted current-folder, then personal workspace. Nested objects merge. Resources and shared permission rules accumulate with their own filtering and precedence; an entire lower scope is not discarded. The helper’s overlap list identifies differing fields, not necessarily errors. Models and account credentials remain global.
- `environment.json` is in the platform’s persistent VarisDev configuration location, independently of `VARISDEV_DATA_DIR`. Saved values, including empty strings, override the machine environment. **Use environment value** in **Menu → Environment** removes a saved entry and restores fallback. Reading or displaying fallback must never save it.

Report environment variable **names, presence, and source labels only**. A child process may already inherit the app’s saved overlay; it cannot reconstruct the original shell fallback. Check **Menu → Environment** in the affected launch for authoritative source labels. Startup normally reads shell startup files, including `.zshrc`; do not source those files again as a diagnostic because they can execute user code. Restart after authorized shell or machine-environment changes.

Use malformed-file findings to propose a precise repair in the correct scope. Preserve unrelated settings. If the shipped schema is unavailable, distinguish parsed JSON from validated settings. `models.json` allows the shipped parser’s line comments and trailing commas; other JSON files use their own formats.

### Extensions, MCP, and authentication

- Inspect package registrations, explicit resource paths, built-in toggles, and the affected session’s existing resource/load diagnostics. Explain missing local paths and shadowed resources with their scope. The helper does not install, update, import, or evaluate any user plugin.
- Compare **loaded** skills, plugins, MCP tools, and hooks with their observed use in the available conversation and their measured context cost. “No use observed in this session” does not mean globally unused. Flag a slow hook only with timing or repeated observed delay; list unmeasured hook cost as unavailable. Offer disabling or narrowing a specific resource only when the evidence supports it.
- MCP files are global, trusted repository/current-folder, and personal workspace `mcp.json`, using `mcpServers`. Project partial overrides can change `enabled`, `exposure`, and `toolExposure` of a global definition; workspace entries need complete definitions. Project files cannot select provider authentication. Check malformed entries, namespace collisions, disabled servers, and missing referenced environment names without printing their values.
- For live MCP state, use the affected session’s existing `/mcp` interface or already available application state. Do not invent a tool or execute a slash command through the shell. Do not connect, reconnect, or start servers just to validate their configuration. `varisdev mcp list` actually connects servers and is not a passive config check. If the interface is unavailable, report connection/authentication state unavailable.
- Authentication is a presence check, not a successful login test. Command-backed keys and references remain unevaluated; expired OAuth access tokens may refresh. Do not make provider calls, refresh credentials, or launch sign-in just to validate presence. Use **Menu → Accounts** or `/login` for an authorized account repair.
- Preserve every plugin’s own authentication contract. A saved Pi OAuth account does not supply a plugin API key. For an installed image plugin that uses the OpenAI Images API, check `OPENAI_API_KEY` presence in the affected launch independently of ChatGPT/ChatPass sign-in; never suggest a different image credential variable or an Accounts fallback.

### Active context, instructions, permissions, and usage

The helper cannot inspect the live Pi session from another process. Use Pi’s shipped `/context` view where it is available, and the selected conversation’s **Context** and **Tokens** information. These are application/session controls, not shell commands. If you cannot open them through an existing interface, complete the disk checkup and report what live evidence is missing; ask the user for the relevant displayed totals only if needed to resolve a finding.

- Report observed context occupancy and model context limit with their source. Inspect the actual loaded system instructions, instruction files, skill advertisements/bodies, tool/MCP schemas, and retained conversation content. Do not turn disk byte counts into exact token counts or assume every discovered skill body is loaded. Pi normally advertises skill metadata and loads the body when read or invoked.
- Review loaded global, repository/current-folder, workspace, and agent-profile guidance. Look for local copies duplicating checked-in guidance, conflicting rules across scopes, and always-loaded text that merely repeats information readily available from project files. Verify a duplication or outdated claim against the relevant file before reporting it. Read only the project facts needed for that verification.
- Propose a concrete trimmed instruction or a move into a relevant skill or referenced guide, retaining a short discoverable pointer when needed. A new nested instruction file helps only where Pi actually discovers it; do not promise Claude Code’s on-demand nested-file behavior. State whether any measured saving covers loaded text, metadata, or an estimate.
- Inspect shared `permissions`, the selected agent profile’s rules, and `/approvals` when accessible. Suggest a narrow existing VarisDev permission rule or remembered approval only for an action the user wants and evidence supports. Frequently denied read-only actions can be discussed using observed examples; denied calls are not permission to allow them. Do not invent an auto permission mode, bypass a deny rule, or claim access to denial frequencies unavailable in the session.
- Use current-session **Tokens** or `/session` statistics for observed usage. Compare options such as a supported smaller model, lower thinking, trimming repeated instructions, or compacting a large conversation only where the evidence supports them. Seven-day subscription usage/recommendations are unavailable unless an existing provider/plugin interface actually supplies them. Report that limit plainly; do not infer plan usage from token estimates or invent a seven-day API.

## `prompt-audit`

Audit instructions rather than running the setup snapshot. Inventory the instruction/configuration sources already loaded in the active session, then read the relevant `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, agent-profile instructions, and `SKILL.md` files in their actual scopes. Include casing variants only where discovered; do not recursively read the whole home directory or project. Keep credentials and unrelated configuration contents out of the report.

Use `/context` and the Context panel to distinguish active instructions, skill metadata, and invoked bodies from merely present files. If live state is unavailable, label the audit as an audit of the inspected files with loading/overhead unverified.

For each finding, give the source and a short non-secret excerpt or rule reference, the conflicting/outdated/duplicated guidance, and the current file or observed behavior that supports the finding. Check for stale paths and commands, mutually incompatible rules, repeated always-loaded guidance, skills whose descriptions no longer match their body, and instructions tied to capabilities the installed app does not provide. Verify claimed conflicts against instruction precedence; do not flag a deliberate scoped override as a contradiction. Propose exact edits or a concise diff, including which skill/guide would receive moved material. Do not turn this into a general source-code review or assume that personal preferences are errors.

## Findings and fixes

Return a concise report grouped by the affected setup areas, or by instruction source for `prompt-audit`:

1. What was checked and the evidence for each actionable finding.
2. A prioritized repair list with the exact file/scope, proposed edit or existing app action, and expected effect.
3. Unavailable checks and observations that need the affected live session.

Propose changes before applying them. Ask for confirmation for fixes the user has not yet authorized. When the user already authorized a specific repair, apply it without asking again. Do not repeatedly ask for the same authorization. A diagnostic invocation alone authorizes read-only inspection, not config edits, package changes, new permissions, authentication, compaction, or deleting installations.

After authorized fixes, rerun only the relevant bounded checks and report what changed and anything still unresolved. Do not rewrite other settings, persist environment fallbacks, or expand a setup checkup into a generic project cleanup.
