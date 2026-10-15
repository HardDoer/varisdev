# Installation

Use the [platform's install command](../README.md#install). Requires [Node.js](https://nodejs.org/) 24+ with npm.

On macOS, installation also adds **VarisDev** to `~/Applications` for Finder, Spotlight, and the Dock.

## Directory and PATH

Default: `~/.local/varisdev` on macOS and Linux, or `%USERPROFILE%\.local\varisdev` on Windows. Set `VARISDEV_INSTALL_DIR` before installing to change it.

The installer configures PATH for Bash, Zsh, Fish, and Nushell, respecting `ZDOTDIR` and `XDG_CONFIG_HOME`. Open a new terminal or use the activation command printed by the installer. Pass `--no-path` to the shell script or `-NoPath` to the PowerShell script to manage PATH yourself.

## Linux sandbox

Installation applies `electron-builder-sandbox-fix`. On systems that restrict unprivileged user namespaces, including affected Ubuntu installations, it starts Electron with `--no-sandbox`.

## Updates

Use **Updates → Check for updates** or `varisdev update`. Restart when prompted.

## Building releases

```sh
npm run release:web -- /path/to/web-release
```

The Dockerfile builds the web release into `/release`. Jenkins publishes a numbered image tag and `varisdev-latest`; deployment uses the latest tag by default and also accepts numbered tags.
