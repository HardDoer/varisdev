# VarisDev configuration

[Back to VarisDev](../README.md)

Commands, accounts, models, settings, skills, prompts, and packages work as in Pi. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), including [MCP servers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md), [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md), and [virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md). This page covers only VarisDev-specific configuration and desktop controls.

## Slash commands

Type `/` in the conversation composer or open **Commands**. Built-in commands are handled by VarisDev, not sent to the model as prompts. Extensions retain their Pi command handlers and arguments; their supported UI requests use the same desktop dialog wrapper.

| Commands | Desktop behavior |
| --- | --- |
| `/thinking [level]`, `/model [provider/model]` | Open a selection dialog when no argument is supplied; otherwise apply the value directly to this session. |
| `/settings` | Open session settings with current values and native selectors. This is separate from **Model defaults**, which configures new sessions. |
| `/scoped-models` | Configure the session's model selection scope, not the background-agent model allowlist. |
| `/login [provider]`, `/logout [provider]` | Open account management. Authentication and sign-out remain explicit user actions. |
| `/new`, `/resume` | Use the desktop session creation and saved-session workflows. |
| `/name [name]`, `/session` | Rename the session or show its information in a dialog. |
| `/tree`, `/fork`, `/clone`, `/import [path]` | Navigate conversation branches, fork or duplicate a conversation, or import a saved JSONL session. |
| `/compact [instructions]`, `/reload` | Compact context or reload resources. |
| `/copy`, `/export [path]` | Copy the last assistant message or export HTML/JSONL. |
| `/share`, `/bug [description]` | Review sharing or private Pi bug-report details before explicitly authorizing an upload. Provider/service credentials or GitHub CLI authentication may be required. |
| `/trust` | Save project trust for future sessions. |
| `/hotkeys`, `/changelog`, `/quit` | Show desktop shortcuts, read the bundled Pi changelog, or confirm application exit. |

Cancelling a picker leaves its value unchanged. Model and thinking changes affect the next model request, not an already-streaming response. Branch changes and other session maintenance require the session to be idle. Terminal appearance settings are not desktop themes; VarisDev's appearance is controlled through **Menu → Theme**.

## Settings directory

VarisDev specific configurations live in `.varisdev`. The folder structure will be familiar to you if you have used Pi.

Set `VARISDEV_SETTINGS_DIR` to use another global configuration directory. No extra `agent/` is appended to a custom path. Pi's directory overrides do not redirect VarisDev.

## Sessions

- **Menu → New session** replaces the selected parent with a fresh conversation in the same folder, stopping its work and agents. Other open parents are unchanged.
- **Menu → Resume session** reopens saved conversations, replacing other open sessions in the same folder. Other projects stay open. Use **Choose folder** to browse another folder's history.
- The start screen's **Recent projects** remembers up to twelve folders across app restarts.
- **Menu → Close session** stops the selected parent and its agents without deleting saved history. For a session connected from a terminal, it only closes the app's view.
- **Remove agent** clears a stopped or finished agent from the dashboard. It reappears if it resumes.

## Models

Use **Menu → Accounts** to connect providers. For server setup, see Pi's [custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) and [llama.cpp](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/llama-cpp.md) documentation.

Use **Menu → Model defaults → Save defaults** to save the model and thinking level for new sessions and immediately apply both to the selected open session. Other open sessions and saved conversations keep their own choices. The dialog's **Current session** controls apply only to the selected parent.

### Agent models

**Menu → Agent models** controls which models background agents may use. All registered models are allowed by default; choose **Only selected models** to restrict them.

Agents inherit the parent's model and reasoning level unless explicitly configured. The inherited model must also be allowed. Restrictions apply across projects, including queued and resumed agents. Changes refresh the agent tool's advertised choices before the next turn, including during an ongoing run; no new session is needed. Running workers keep their current model.

For virtual models, the router's extension must also be loaded from the worker's project or global configuration.

### Commit settings

**Menu → Commit settings** selects the model and reasoning level for VarisDev's [`/commit` agent](reference.md#commit-and-push), or lets them inherit from the parent. Its model must be allowed in **Agent models**.

### Image and audio models

Image and audio tools require separate model choices. The GUI asks on first use; change them in **Menu → Accounts → Tool models**.

Request parameters or these environment variables override saved choices:

- `OPENAI_IMAGE_MODEL`
- `ELEVENLABS_SPEECH_MODEL`
- `ELEVENLABS_EFFECTS_MODEL`

## Desktop storage

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/VarisDev/` |
| Windows | `%LOCALAPPDATA%/VarisDev/` |
| Linux | `$XDG_DATA_HOME/varisdev/`, or `~/.local/share/varisdev/` |

`VARISDEV_DATA_DIR` overrides this directory. It holds desktop preferences, logs, and downloaded application updates.

## macOS launcher

Use `varisdev app install` to reinstall the launcher in `~/Applications`.

Finder uses the executable search path and settings directory recorded when the launcher was installed. Extra environment settings can be placed in `~/Library/Application Support/VarisDev/environment.json` as a JSON object of string values.

## CLI

`varisdev --help` lists VarisDev commands. `varisdev run` accepts Pi's [terminal automation options](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#cli-reference). For application updates, see [Updates](installation.md#updates).
