# Installation

First, [download and install Node.js](https://nodejs.org/en/download) 24 or newer (npm is included). Open a new terminal, then use the [platform's install command](../README.md#install).

On macOS, installation also adds **VarisDev** to `~/Applications` for Finder, Spotlight, and the Dock.

On Windows, installation adds **VarisDev** to the Start menu. Open it there and pin its window to the taskbar. The pinned icon opens the start view. Run `varisdev app install` to add or repair the shortcut after a direct npm installation or an update from an older version.

If an existing taskbar icon opens Electron or shows the Electron logo, unpin it, open the updated VarisDev, and pin its window again.

## Directory and PATH

Default: `~/.local/varisdev` on macOS and Linux, or `%USERPROFILE%\.local\varisdev` on Windows. Set `VARISDEV_INSTALL_DIR` before installing to change it.

The installer configures PATH for Bash, Zsh, Fish, and Nushell, respecting `ZDOTDIR` and `XDG_CONFIG_HOME`. Open a new terminal or use the activation command printed by the installer. Pass `--no-path` to the shell script or `-NoPath` to the PowerShell script to manage PATH yourself.

### Permission denied opening a shell startup file

An error such as `EACCES: permission denied, open '/Users/you/.zshrc'` during PATH setup means the app has been installed, but the installer cannot update that shell file. On macOS, open `~/Applications/VarisDev.app`, or launch a default installation from the terminal:

```sh
"$HOME/.local/varisdev/bin/varisdev"
```

To use `varisdev` in the current terminal:

```sh
export PATH="$HOME/.local/varisdev/bin:$PATH"
```

For a permanent PATH entry, add that export to a shell startup file you can edit. Use your custom install directory if you chose one.

## Updates

Use **Updates → Check for updates** or `varisdev update`. Restart when prompted.

If an older installation cannot update, quit VarisDev and run the [install command](../README.md#install) again with the same installation directory. Reinstalling preserves your sessions and settings.

## Uninstall

Quit VarisDev before uninstalling.

On Windows, unpin VarisDev from the taskbar and delete `%APPDATA%\Microsoft\Windows\Start Menu\Programs\VarisDev.lnk`.

### Website installer

**macOS / Linux**

```sh
npm uninstall --global --prefix "$HOME/.local/varisdev" varisdev
```

**Windows (PowerShell)**

```powershell
npm uninstall --global --prefix "$HOME\.local\varisdev" varisdev
```

If you chose a custom install directory, use that path instead. On macOS, also delete `~/Applications/VarisDev.app`.

Remove the installer's PATH entry:

- **Bash:** remove the `# VarisDev` comment and its PATH line from `~/.bashrc` and your login file (`~/.bash_profile`, `~/.bash_login`, or `~/.profile`).
- **Zsh:** remove the same block from `~/.zshrc` and `~/.zprofile` (under `ZDOTDIR` if set).
- **Fish:** delete `~/.config/fish/conf.d/varisdev.fish` (under `XDG_CONFIG_HOME` if set).
- **Nushell:** remove the `# VarisDev` comment and its PATH line from `~/.config/nushell/env.nu`, or `~/Library/Application Support/nushell/env.nu` on macOS (under `XDG_CONFIG_HOME` if set).
- **Windows:** open **Environment Variables → User variables → Path** and remove `%USERPROFILE%\.local\varisdev`, or your custom install directory.

Open a new terminal after changing PATH.

### Direct npm installation

If you installed globally with npm:

```sh
npm uninstall --global varisdev
```

On macOS, also delete `~/Applications/VarisDev.app` if you installed the launcher.

### Remove saved data (optional)

To remove desktop preferences, logs, and downloaded updates, delete the [desktop storage directory](configuration.md#desktop-storage), or the directory set by `VARISDEV_DATA_DIR`.

To remove VarisDev's sessions, credentials, settings, and plugins, delete `~/.varisdev` (`%USERPROFILE%\.varisdev` on Windows), or the directory set by `VARISDEV_SETTINGS_DIR`. The default global profile is `~/.varisdev/agent/`; deleting the whole `.varisdev` directory also removes any backups from older versions. Project settings and plugins are stored in each project's `.varisdev` directory. Standalone Pi's `.pi` directories are separate and should be left untouched.
