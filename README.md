# VarisDev

VarisDev is built on top of the open-source coding harness [Pi](https://pi.dev), adding a desktop GUI, some tools and a data visualization layer. Its designed to be as minimal as possible and does not pollute your prompts with anything or enforce any particular workflows. Its functions should be very familiar to anyone who has used Pi.

Pi is a very cool project and VarisDev would not have been possible without it. Check it out [here](https://github.com/earendil-works/pi).

## Install

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

Requires [Node.js](https://nodejs.org/) 24+.

Open a new terminal and run `varisdev`. On macOS, the installer also adds VarisDev to `~/Applications`.

See [installation options](docs/installation.md).

## Features

- Parent sessions and background agents with a cool 3D-view reminiscent of early 2000s tycoon games.
- Makes you look like you are not working when in fact you are!
- Robots drinking coffee!
- Detailed visualizations regarding whatever the agents are doing and token usage.
- Context files, Markdown editing, and image previews.
- Supports all plugins that Pi supports. Though because the visualization is quite different some plugins that do UI-stuff probably do not work that well. You have been warned!
- Has its own theming system that you can extend as you wish.
- Additional tools for browsing, structured data, images, and audio.

## Updates

Use **Updates → Check for updates** in the app, or run `varisdev update`.

## Commands

Since VarisDev uses Pi under the hood many of the things you see in VarisDev work exactly like in Pidev. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#commands).

## VarisDev documentation

- [Configuration and CLI](docs/configuration.md)
- [Agents and tools](docs/reference.md)
- [Plugin visuals and themes](docs/plugins.md)
- [Development](CONTRIBUTING.md)
