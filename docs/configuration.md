# VarisDev configuration

[Back to VarisDev](../README.md)

For accounts, runtime settings, skills, and package commands, see [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

## Models

Choose the parent model in **Menu → Model & settings**. VarisDev remembers your selection. Agents inherit it unless you explicitly select another model.

Image and audio tools need separate models. On first use, the GUI explains this and asks you to choose. Change saved choices in **Menu → Accounts → Tool models**. Request parameters or these environment variables can override them:

- `OPENAI_IMAGE_MODEL`
- `ELEVENLABS_SPEECH_MODEL`
- `ELEVENLABS_EFFECTS_MODEL`

Saved tool choices live in `varisdev/tool-models/` under Pi's configured agent directory. There are no preset models.

## Desktop storage

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/VarisDev/` |
| Windows | `%LOCALAPPDATA%/VarisDev/` |
| Linux | `$XDG_DATA_HOME/varisdev/`, or `~/.local/share/varisdev/` |

`VARISDEV_DATA_DIR` overrides this directory. The `desktop` subdirectory contains preferences and `startup.log`; `runtimes` contains application updates.

## macOS launcher

`varisdev app install` adds VarisDev to `~/Applications`. The launcher follows application updates automatically.

Finder uses the executable search path and agent directory recorded when the launcher was installed. Extra environment settings can be placed in `~/Library/Application Support/VarisDev/environment.json` as a JSON object of string values.

## CLI

`varisdev --help` lists VarisDev commands. `varisdev run` exposes Pi's terminal automation options. The GUI and `varisdev update` both update the full application and its bundled dependencies. Website installations download verified application packages from joonas.ninja; existing Git installations use their Git source. Updates preserve the working installation if preparation fails. See [installation and release publishing](installation.md).
