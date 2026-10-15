# VarisDev configuration

[Back to VarisDev](../README.md)

For accounts, runtime settings, skills, and package commands, see [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

## Sessions

Type **`/new`** in the parent composer and send it, or use **Menu → New session**, to start a fresh conversation in the current folder. The new parent starts with empty conversation history; the previous parent and its agents remain open. `/new` takes no arguments and does not require a selected model.

Use **Menu → Resume session** to reopen a saved conversation in the current folder. Sessions appear newest first. Use **Choose folder** in the dialog to browse another folder's history.

Use **Menu → Close session** to close the selected parent and stop its running work and agents. The saved conversation remains available to resume. For a session connected from a terminal, this closes its view in the app.

Select a stopped or finished agent and click **Remove agent** to clear it from the dashboard. It appears again if it resumes.

## Models

Choose the parent model in **Menu → Model & settings**. VarisDev remembers your selection.

### llama.cpp

Start a recent llama.cpp server in router mode, pointing it at your GGUF model directory. For example:

```sh
llama-server --models-dir ./models --no-models-autoload --jinja --host 127.0.0.1 --port 8080 -c 32768
```

Adjust the directory, context size, and GPU options for your setup. Router mode starts without `-m` or `--model`.

1. Open **Menu → Accounts**, select **llama.cpp**, and click **Connect server**.
2. Enter the server URL, or leave it blank for `http://127.0.0.1:8080`. The API key is optional unless your server requires one.
3. Send **`/llama`** in the parent composer. Select an unloaded model to load it, or a loaded model to unload it.
4. Select a loaded model in **Menu → Model & settings**. Background agents can inherit it or use it through **Agent models**.

**Download model…** accepts a Hugging Face search or `owner/repository[:quantization]`. Select the repository and quantization; the server downloads the model. For gated repositories, grant access on Hugging Face and provide `HF_TOKEN` to the llama.cpp server. `HF_TOKEN` in VarisDev also authenticates its repository searches.

Loading and downloading show progress. **Cancel**, **Escape**, **Stop**, or closing the parent cancels its active operation. If other models are loaded, choose whether to keep them loaded or unload them first. Saved GGUF files stay on the server.

`LLAMA_BASE_URL` and optional `LLAMA_API_KEY` can configure the connection instead of Accounts. Set them before starting VarisDev. The server runs separately from VarisDev.

### Custom local servers

VarisDev uses Pi's `models.json` format for servers such as Ollama, LM Studio, and llama.cpp in single-model mode. The file is in `~/.varisdev`, or the directory set by `VARISDEV_SETTINGS_DIR`. The model runs in your server; VarisDev connects to its API.

For a llama.cpp server at `http://127.0.0.1:8080`, add a provider like this to `models.json`, keeping any existing providers:

```json
{
  "providers": {
    "local-llama": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        {
          "id": "your-served-model-id",
          "contextWindow": 32768,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

Use the model ID reported by the server and a context size it supports. `local` is a placeholder for a server without authentication; replace it with your API key when required. For coding tools, use a model with tool calling support and enable the appropriate chat template in the server, such as llama.cpp's `--jinja` option.

For Ollama, use `http://127.0.0.1:11434/v1` and its installed model tag, such as `llama3.1:8b`. After editing the configuration, open a new session and select the model in **Menu → Model & settings**.

The **`/llama`** manager connects to the llama.cpp router configured above. Ollama and other custom providers use their own model management tools.

### Agent models

Open **Menu → Agent models** to search Pi's model catalog and choose which models background agents may use. By default, all registered models are allowed. Choose **Only selected models** to restrict agents to your selection.

Agents inherit the parent session's model and reasoning level when their request omits those values. An inherited model must also be allowed; VarisDev asks for an allowed choice rather than switching models automatically. Saved restrictions apply to open sessions, queued agents when they start, and completed agents when they resume.

The first time an agent appears, a notice explains model and reasoning inheritance and links directly to **Agent models**. Its acknowledgment is saved in the desktop profile.

### Commit settings

Open **Menu → Commit settings** to select the model and reasoning level used by `/commit`. Each setting can inherit the parent session's choice. The selected model must be allowed in **Agent models**.

Before the first `/commit` request, a separate notice explains that the commit agent inherits the parent session's model and reasoning level by default. It links to **Commit settings**, where you can override those values, and describes the commit-and-push task. Opening the settings keeps the command in your draft so you can send it after configuring the tool.

Agent and commit settings are saved in `varisdev/tool-settings.json` under VarisDev's settings directory. These settings apply across projects.

### Image and audio models

Image and audio tools need separate models. On first use, the GUI explains this and asks you to choose. Change saved choices in **Menu → Accounts → Tool models**. Request parameters or these environment variables can override them:

- `OPENAI_IMAGE_MODEL`
- `ELEVENLABS_SPEECH_MODEL`
- `ELEVENLABS_EFFECTS_MODEL`

Saved tool choices live in `varisdev/tool-models/` under VarisDev's settings directory. There are no preset models.

## Settings and sessions

VarisDev stores accounts, models, settings, plugins, and sessions in `~/.varisdev` (`%USERPROFILE%\.varisdev` on Windows). Set `VARISDEV_SETTINGS_DIR` to use another directory.

Project settings and plugins use `.varisdev` inside the project folder. Regular Pi keeps its own settings in `.pi`.

When upgrading from a version that shared Pi's settings, connect your accounts through **Menu → Accounts** and configure your models and plugins in VarisDev. Existing Pi settings are not imported automatically.

## Desktop storage

| Platform | Default directory                                         |
| -------- | --------------------------------------------------------- |
| macOS    | `~/Library/Application Support/VarisDev/`                 |
| Windows  | `%LOCALAPPDATA%/VarisDev/`                                |
| Linux    | `$XDG_DATA_HOME/varisdev/`, or `~/.local/share/varisdev/` |

`VARISDEV_DATA_DIR` overrides this directory. The `desktop` subdirectory contains preferences and `startup.log`; `runtimes` contains application updates.

## macOS launcher

The macOS installer adds VarisDev to `~/Applications`. Use `varisdev app install` to reinstall the launcher. The launcher follows application updates automatically.

Finder uses the executable search path and settings directory recorded when the launcher was installed. Extra environment settings can be placed in `~/Library/Application Support/VarisDev/environment.json` as a JSON object of string values.

## CLI

`varisdev --help` lists VarisDev commands. `varisdev run` exposes Pi's terminal automation options. The GUI and `varisdev update` both update the full application and its bundled dependencies. Website installations download verified application packages from joonas.ninja; existing Git installations use their Git source. Updates preserve the working installation if preparation fails. See [installation options](installation.md).
