# Tasks

## Current

- [x] Give VarisDev its own settings directory at `~/.varisdev`, including accounts, models, sessions, plugins, and tool preferences. Project settings use `.varisdev` too.
- [x] Keep CLI, desktop launchers, updates, and background agents on the same VarisDev settings directory.
- [x] Verify the bundled Pi works with the separate directory and regular Pi settings remain untouched, including when launched from a VarisDev child process.
- [x] Update settings and uninstall documentation and run relevant checks. Settings isolation, CLI, accounts, plugins, sessions, Windows launchers, restart/startup, build, typecheck, and lint checks passed. The macOS integration test was skipped on Windows.

## Later

- [ ] Update all three bundled Pi packages from `0.85.1` to the latest release (currently `1.2.0`) in the root and desktop manifests and lockfiles.
  - [ ] Check compatibility with VarisDev and run the relevant tests before release.
