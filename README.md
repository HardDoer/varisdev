# VarisDev

VarisDev is built on top of the open-source coding harness [Pi](https://pi.dev), adding a desktop GUI, some tools and a data visualization layer. Its designed to be as minimal as possible and does not pollute your prompts with anything or enforce any particular workflows. Its functions should be very familiar to anyone who has used Pi.

Pi is a very cool project and VarisDev would not have been possible without it. Check it out [here](https://github.com/earendil-works/pi).

## Features

- Parent sessions and background agents with a cool 3D-view reminiscent of early 2000s tycoon games.
- Makes you look like you are not working when in fact you are!
- Robots drinking coffee!
- Detailed visualizations regarding whatever the agents are doing and token usage.
- Context files, Markdown editing, and image previews.
- Loads Pi packages and extension commands, with native desktop dialogs for Pi's built-in slash commands. Terminal-specific plugin rendering and shortcuts have compatibility limitations.
- Has its own theming system that you can extend as you wish.
- Additional tools for browsing, structured data, images, and audio.

## Install

### 1. [↓ Download Node.js](https://nodejs.org/en/download)

**Install this first — Node.js 24 or newer is required.** The official installer includes npm and supports Windows, macOS, and Linux. Already installed? Continue to step 2.

### 2. Install VarisDev

**macOS / Linux**

```sh
curl -fsSL https://joonas.ninja/varisdev/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://joonas.ninja/varisdev/install.ps1 | iex
```

**Windows (Command Prompt)**

```cmd
curl -fsSLo install.cmd https://joonas.ninja/varisdev/install.cmd && install.cmd
```

### 3. Launch VarisDev

Open a new terminal and run `varisdev`. On Windows, you can also open VarisDev from the Start menu. On macOS, the installer adds VarisDev to `~/Applications`.

See [installation options](docs/installation.md) and [uninstall instructions](docs/installation.md#uninstall).

## Updates

Use **Updates → Check for updates** in the app, or run `varisdev update`.

## Commands

Pi's built-in slash commands are routed through VarisDev's desktop UI. For example, `/thinking`, `/model`, and `/settings` open native dialogs; `/thinking high` and `/model provider/model` also accept direct arguments. Installed extensions, templates, and skills add their own commands. See [desktop commands](docs/configuration.md#slash-commands) and [Pi's command reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/slash-commands.md).

## VarisDev documentation

- [Configuration and CLI](docs/configuration.md)
- [Agents and tools](docs/reference.md)
- [Plugin visuals and themes](docs/plugins.md)

## License

VarisDev is open source under the [MIT License](LICENSE). Copyright © 2026 Joonas Nousiainen.

Pi and other third-party components retain their respective licenses and copyright notices. Pi's original MIT license, including Mario Zechner's copyright notice, is preserved in [licenses/pi-MIT.txt](licenses/pi-MIT.txt). See [third-party notices](THIRD_PARTY_NOTICES.md).
