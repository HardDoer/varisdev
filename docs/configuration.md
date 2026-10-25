# VarisDev configuration

[Back to VarisDev](../README.md)

Commands, accounts, models, settings, skills, prompts, and packages work as in Pi. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), including [MCP servers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md), [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md), and [virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md). This page covers only VarisDev-specific configuration and desktop controls.

## Slash commands

Type `/` in the conversation composer or open **Commands**. Installed extensions add their own commands with their usual arguments.

| Commands                                        | Desktop behavior                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/thinking [level]`, `/model [model or search]` | Open Pi's selector, or apply an exact match to this session.                                                  |
| `/fast`, `/ultrafast`                           | Toggle a supported speed mode for the current model.                                                          |
| `/settings`                                     | Open session settings with current values and selectors.                                                      |
| `/scoped-models`                                | Configure the session's model selection scope, not the background-agent model allowlist.                      |
| `/login [provider]`, `/logout`                  | Open Pi's sign-in or sign-out selector.                                                                       |
| `/new`                                          | Open the desktop conversation creation workflow.                                                              |
| `/resume`                                       | Open Pi's native session selector, including search, rename, and delete controls.                             |
| `/name [name]`, `/session`                      | Rename the session or show its information in a dialog.                                                       |
| `/tree`, `/fork`, `/clone`, `/import [path]`    | Navigate conversation branches, fork or duplicate a conversation, or import a saved JSONL session.            |
| `/compact [instructions]`, `/reload`            | Compact context or reload resources.                                                                          |
| `/copy`, `/export [path]`                       | Copy the last assistant message or export HTML/JSONL.                                                         |
| `/share`, `/bug [description]`                  | Run Pi's native sharing or bug-report flow. `/share` publishes the session using Pi's configured destination. |
| `/trust`                                        | Save project trust for future sessions.                                                                       |
| `/approvals`                                    | Review and revoke remembered approvals for this agent.                                                        |
| `/hotkeys`, `/changelog`, `/quit`               | Show desktop shortcuts, read the bundled Pi changelog, or confirm application exit.                           |

`/bug` saves its ZIP export in the app's startup directory and shows the full path.

Model and thinking changes take effect on the next model request. `/reload` requires an idle session. Branch changes stop active work when applied. Terminal appearance settings are not desktop themes; VarisDev's appearance is controlled through **Menu → Appearance → Theme**. **Year1998** uses a teal desktop, beveled silver controls, navy title bars, classic system fonts, and an isometric pixel office for the live agent scene.

## Settings directory

VarisDev specific configurations live in `.varisdev`. The folder structure will be familiar to you if you have used Pi.

Set `VARISDEV_SETTINGS_DIR` to use another global configuration directory. No extra `agent/` is appended to a custom path. Pi's directory overrides do not redirect VarisDev.

**Menu → Open workspace configuration** opens the machine-local configuration directory associated with the canonical repository or worktree path. It is stored under `<agentDir>/workspaces/<project-hash>/`; symlink aliases share a hash, while separate Git worktrees and moved repositories have separate configuration. All project subdirectories use the same workspace directory.

Workspace configuration can contain `settings.json`, `skills/`, `prompts/`, `extensions/`, `themes/`, package registrations, `mcp.json`, and Pi context files such as `AGENTS.md`, `AGENTS.MD`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.MD`, `SYSTEM.md`, and `APPEND_SYSTEM.md`. Workspace preferences and resources override trusted repository configuration, which overrides global configuration; existing repository and global resources remain available. Context instructions accumulate in Pi's normal order and apply workspace instructions last. `/reload` rereads these files.

Interactive Pi settings commands keep their existing global or repository save behavior; workspace `settings.json` is an overlay edited as a file. Every conversation selects an agent from the Markdown configurations described in [Agent configurations](agents.md). The empty **Default** agent preserves normal Pi behavior. Set `default_agent` to choose another visible primary or all-mode profile. Shared `permissions` in settings apply before profile rules. `models.json` and `auth.json` remain global. MCP entries in the workspace file must contain complete server definitions rather than partial `{enabled}` overrides.

## Workspaces

Open **Actions** beside the conversation title, or right-click a workspace, agent, history entry, or the conversation title. Right-clicking selects that item. With an item focused, **Shift+F10** or the menu key opens its actions; use the arrow keys to navigate and **Esc** to close. **Actions** remains available when the visualization is hidden.

- **New conversation** automatically selects **Default**, or the eligible profile chosen by `default_agent`. You can choose another configuration; a name and initial task are optional. See [agent configurations](agents.md).
- **Actions → Reset conversation** replaces the selected workspace with a fresh main-agent conversation in the same folder, stopping all of its agents. **Menu → Reset conversation** also offers reset and retry.
- **Menu → Resume session** reopens a saved conversation as a workspace, replacing other open workspaces in the same folder. Other projects stay open. Use **Choose folder** to browse another folder's history.
- The start screen's **Recent projects** remembers up to twelve folders across app restarts.
- **Actions → Close workspace** closes the selected workspace and stops all of its agents without deleting saved history. A workspace connected from a terminal is only dismissed from the app.
- **Actions → Cancel agent** stops the selected additional agent; **Cancel all agents** is available from its workspace's actions.
- **Actions → Remove agent** clears a stopped or finished additional agent from the dashboard. It reappears if it resumes.

## Panel layout and sizes

**Menu → Appearance → Panel layout** controls the visualization, workspace list, and agents and history panels. All are shown by default. Hide all three for a full-width conversation; **Info** and **Actions** beside the conversation title keep session details and actions accessible. Visibility is remembered across app restarts. **Menu → Appearance → Reset panel layout** restores default visibility, panel splits, and composer sizes.

**Menu → Appearance → Weapons** contains the Cane, Gun, and Flamethrower when the visualization is shown.

Drag the dividers to resize the conversation and live view, the workspace list, or the active agents and history panels. Drag the divider above the composer to adjust the space used by the conversation and the prompt or terminal. Sizes are remembered across app restarts.

Focus a divider with **Tab** and use the arrow keys to resize it; hold **Shift** for larger steps. **Home** and **End** select its smallest and largest sizes. Double-click a divider or press **Enter** to reset it. **Esc** cancels a drag.

Panel sizes adjust to fit the window and zoom level. Hiding panels lets the remaining panels fill the available space; showing them again restores your preferred sizes. In short windows, **Agents & history** opens the agent panels in a drawer.

## Models

Use **Menu → Accounts** to connect providers. For server setup, see Pi's [custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) and [llama.cpp](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/llama-cpp.md) documentation.

**Menu → Model & thinking** opens Pi's selectors in **Model** and **Thinking** tabs. **Apply to session** changes the current session; **Make as default** also saves the choice for new sessions. `/model` and `/thinking` open the corresponding tab.

For sessions attached from a terminal, open picker dialogs in that terminal. Exact `/model provider/model` and `/thinking level` commands also work from the desktop.

### Speed modes

`/fast` and `/ultrafast` toggle the named mode for the agent receiving the prompt. Selecting the other mode switches to it; repeating the active command returns to regular speed. Both also accept `on` or `off`.

The **Speed** tab beside **Conversation** and **Live feed** changes the selected agent's mode directly, including subagents. Unsupported modes are disabled; a model that supports only regular speed disables the switch. Each agent has its own setting, and newly spawned agents start at regular speed.

A lightning icon beside **Effort** indicates Fast; two indicate Ultrafast. Regular speed has no icon. The selection is saved per model in the conversation and applies to the next model request without changing thinking effort. A request already in progress keeps its current mode.

| Provider                    | Fast                                                                                                               | Ultrafast                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Anthropic API               | Claude Opus 5.5, Opus 5, and Opus 4.8                                                                              | Unavailable                                   |
| OpenAI API                  | Models listed in OpenAI's [Fast pricing table](https://developers.openai.com/api/docs/pricing?latest-pricing=fast) | GPT-6 Astra and GPT-6.1 Sol                   |
| OpenAI with ChatGPT sign-in | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, and GPT-5.6 models                                                | GPT-6 Astra and GPT-6.1 Sol on eligible plans |

These modes use higher provider rates. Cost estimates in **Tokens** use configured model prices and may omit Fast or Ultrafast premiums. Anthropic's Opus 5 and 4.8 Fast mode requires preview access; ChatGPT Ultrafast requires an eligible subscription and workspace access. Unsupported model or provider combinations report an error and keep the current mode. Custom gateways are not included.

Provider details: [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode), [OpenAI Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode), and [ChatGPT speed and plan requirements](https://learn.chatgpt.com/docs/agent-configuration/speed).

### Agent models

**Menu → Tool models → Maximum concurrent agents** sets the total allowed per conversation, including its main agent. The default is **6**, leaving five slots for additional agents. Set **1** to use only the main agent. Additional work queues when all slots are occupied. Lowering the limit lets running agents finish; the new limit applies to subsequent launches and resumptions.

The **Agent models** section in **Menu → Tool models** controls which models background agents may use when their configuration has no explicit model. Fresh settings start with none selected.

**Agent models** uses the selected workspace's Pi scoped models, or the saved global scope when no workspace is selected. An empty scope shows the full model catalog. Saved choices outside the current scope remain visible as unavailable.

Agents inherit the current agent's model and reasoning level unless explicitly configured. The inherited or launch-selected model must be allowed. An explicit model in an agent configuration pins that agent type to the model, overriding this list and launch arguments. Both restrictions and pins apply across projects, including queued and resumed agents. Changes apply to subsequent agent launches and resumptions. Running agents keep their current model.

For virtual models, the router's extension must also be loaded from the worker's project or global configuration.

### Image model

Choose an OpenAI image preset on first GUI use or in **Menu → Tool models → OpenAI images**. The choice is saved for future requests. Presets include GPT Image 2.5 Sunburst, GPT Image 2.5 Flare, GPT Image 2, GPT Image 1.5, GPT Image 1, and GPT Image 1 Mini. Sunburst prioritizes editing precision; Flare is suited to fast, high-quality everyday images.

The `model` request parameter takes precedence over the saved choice, which takes precedence over `OPENAI_IMAGE_MODEL`. Selecting the environment option removes the saved choice. Environment values appear muted with their source. Existing model IDs remain supported. Without an interactive UI or a configured choice, the tool uses `gpt-image-2.5-flare`.

## Environment

Open **Menu → Environment** to view or edit environment settings. Values are hidden until you choose **Show**. Values read from the machine environment appear muted and are labeled; viewing them does not save them.

Saving a value writes that variable to `environment.json`. Saved values take precedence over the machine environment. **Use environment value** deletes the saved entry and restores the environment value.

On macOS and systems with Zsh, startup reads exported variables from `.zshrc` for both desktop and terminal launches. Native Windows preserves the inherited environment and adds missing entries from the system and user `Path`. Changes to tool credentials apply to subsequent requests; changes to startup paths require restarting the app.

The settings file is stored at:

- macOS: `~/Library/Application Support/VarisDev/environment.json`
- Windows: `%LOCALAPPDATA%/VarisDev/environment.json`
- Linux: `$XDG_CONFIG_HOME/varisdev/environment.json`, or `~/.config/varisdev/environment.json`

## Desktop storage

| Platform | Default directory                                         |
| -------- | --------------------------------------------------------- |
| macOS    | `~/Library/Application Support/VarisDev/`                 |
| Windows  | `%LOCALAPPDATA%/VarisDev/`                                |
| Linux    | `$XDG_DATA_HOME/varisdev/`, or `~/.local/share/varisdev/` |

`VARISDEV_DATA_DIR` overrides this directory. It holds desktop preferences, logs, and downloaded application updates.

## macOS launcher

Use `varisdev app install` to reinstall the launcher in `~/Applications`.

Finder launches load exported variables from `.zshrc` at startup. Saved [environment settings](#environment) take precedence.

## CLI

`varisdev --help` lists VarisDev commands. `varisdev run` accepts Pi's [terminal automation options](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#cli-reference). For application updates, see [Updates](installation.md#updates).

On Linux, including WSLg, use `varisdev --ozone-platform=x11` or `varisdev --ozone-platform=wayland` to select the display backend for that launch. Both accept a project folder or `--overview`; omitting the option uses Electron's default. Fully quit the app before switching backends.
