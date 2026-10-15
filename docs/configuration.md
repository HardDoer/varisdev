# VarisDev configuration

[Back to VarisDev](../README.md)

For accounts, runtime settings, skills, and package commands, see [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

## Sessions

Use **Menu → New session** to start a fresh conversation in the current folder.

Use **Menu → Resume session** to reopen a saved conversation in the current folder. Sessions appear newest first. Use **Choose folder** in the dialog to browse another folder's history.

Use **Menu → Close session** to close the selected parent and stop its running work and agents. The saved conversation remains available to resume. For a session connected from a terminal, this closes its view in the app.

Select a stopped or finished agent and click **Remove agent** to clear it from the dashboard. It appears again if it resumes.

## Models

Choose the parent model in **Menu → Model & settings**. VarisDev remembers your selection.

### Agent models

Open **Menu → Agent models** to search Pi's model catalog and choose which models background agents may use. By default, all registered models are allowed. Choose **Only selected models** to restrict agents to your selection.

Agents inherit the parent session's model and reasoning level when their request omits those values. An inherited model must also be allowed; VarisDev asks for an allowed choice rather than switching models automatically. Saved restrictions apply to open sessions, queued agents when they start, and completed agents when they resume.

The first time an agent appears, a notice explains model and reasoning inheritance and links directly to **Agent models**. Its acknowledgment is saved in the desktop profile.

### Commit settings

Open **Menu → Commit settings** to select the model and reasoning level used by `/commit`. Each setting can inherit the parent session's choice. The selected model must be allowed in **Agent models**.

Before the first `/commit` request, a separate notice explains that the commit agent inherits the parent session's model and reasoning level by default. It links to **Commit settings**, where you can override those values, and describes the commit-and-push task. Opening the settings keeps the command in your draft so you can send it after configuring the tool.

Agent and commit settings are saved in `varisdev/tool-settings.json` under Pi's configured agent directory. These settings apply across projects.

### Image and audio models

Image and audio tools need separate models. On first use, the GUI explains this and asks you to choose. Change saved choices in **Menu → Accounts → Tool models**. Request parameters or these environment variables can override them:

- `OPENAI_IMAGE_MODEL`
- `ELEVENLABS_SPEECH_MODEL`
- `ELEVENLABS_EFFECTS_MODEL`

Saved tool choices live in `varisdev/tool-models/` under Pi's configured agent directory. There are no preset models.

## Desktop storage

| Platform | Default directory                                         |
| -------- | --------------------------------------------------------- |
| macOS    | `~/Library/Application Support/VarisDev/`                 |
| Windows  | `%LOCALAPPDATA%/VarisDev/`                                |
| Linux    | `$XDG_DATA_HOME/varisdev/`, or `~/.local/share/varisdev/` |

`VARISDEV_DATA_DIR` overrides this directory. The `desktop` subdirectory contains preferences and `startup.log`; `runtimes` contains application updates.

## macOS launcher

The macOS installer adds VarisDev to `~/Applications`. Use `varisdev app install` to reinstall the launcher. The launcher follows application updates automatically.

Finder uses the executable search path and agent directory recorded when the launcher was installed. Extra environment settings can be placed in `~/Library/Application Support/VarisDev/environment.json` as a JSON object of string values.

## CLI

`varisdev --help` lists VarisDev commands. `varisdev run` exposes Pi's terminal automation options. The GUI and `varisdev update` both update the full application and its bundled dependencies. Website installations download verified application packages from joonas.ninja; existing Git installations use their Git source. Updates preserve the working installation if preparation fails. See [installation options](installation.md).
