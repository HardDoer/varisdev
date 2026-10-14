# VarisDev

VarisDev is built on top of [Pi (pi.dev)](https://pi.dev), adding a desktop GUI and visualization layer.

Pi provides the coding agent runtime. Pi is a very cool project, and the foundation that makes this possible—check out [its repository](https://github.com/earendil-works/pi).

## Vision

A minimal visual layer over Pi that preserves its capabilities and keeps your prompts intact. The idea is to make AI engineering feel like playing a game from the early 2000s.

## Install

Requires [Node.js](https://nodejs.org/) 24.15+ on the 24.x line or 26+, Git, and npm 12.

Upgrade npm if needed:

```sh
npm install -g npm@12
```

npm 12 fixes a global Git installation bug in npm 11 that can cause `Cannot find module 'npm/package.json'`. The options below enable Git installation and VarisDev's automatic setup.

```sh
npm install -g --allow-git=root --allow-scripts=github:HardDoer/varisdev git+https://github.com/HardDoer/varisdev.git
varisdev
```

## Use

- **Menu → Accounts**: connect a provider or sign out. Existing Pi credentials work.
- **Open folder**: choose a project.
- **Menu → Model & settings**: select a model and thinking level.

## Features

- Parent sessions and background agents with a live factory view.
- Conversations, tool activity, file changes, and token usage.
- Context files, Markdown editing, and image previews.
- Pi extensions, skills, prompt templates, and themes.
- Additional tools for browsing, structured data, images, and audio.

## Updates

Use **Updates → Check for updates** in the app, or run `varisdev update`.

## Pi runtime

For the underlying runtime's commands, extensions, and configuration, see [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#commands).

## VarisDev documentation

- [Configuration and CLI](docs/configuration.md)
- [Agents and tools](docs/reference.md)
- [Plugin visuals and themes](docs/plugins.md)
- [Development](CONTRIBUTING.md)
