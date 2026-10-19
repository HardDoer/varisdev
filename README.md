# VarisDev

VarisDev is built on top of the open-source coding harness [Pi](https://pi.dev), adding a desktop GUI, some tools and a data visualization layer. Its designed to be as minimal as possible and does not pollute your prompts with anything or enforce any particular workflows. Its functions should be very familiar to anyone who has used Pi.

Pi is a very cool project and VarisDev would not have been possible without it. Check it out [here](https://github.com/earendil-works/pi).

## Features

- Parent sessions and background agents with a cool 3D-view reminiscent of early 2000s tycoon games.
- Makes you look like you are not working when in fact you are!
- Robots drinking coffee!
- Detailed visualizations regarding whatever the agents are doing and token usage.
- Context files, Markdown editing, and image previews.
- Loads Pi packages and extension commands. Terminal-specific plugin rendering and shortcuts have compatibility limitations.
- Has its own theming system that you can extend as you wish.
- Additional tools for browsing, structured data, and images.

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

Since VarisDev uses Pi under the hood many of the things you see in VarisDev work exactly like in Pidev. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#commands).

## VarisDev documentation

- [Configuration and CLI](docs/configuration.md)
- [Agents and tools](docs/reference.md)
- [Plugin visuals and themes](docs/plugins.md)

## License

VarisDev is open source under the [MIT License](LICENSE). Copyright © 2026 Joonas Nousiainen.

Pi and other third-party components retain their respective licenses and copyright notices. Pi's original MIT license, including Mario Zechner's copyright notice, is preserved in [licenses/pi-MIT.txt](licenses/pi-MIT.txt). See [third-party notices](THIRD_PARTY_NOTICES.md).
