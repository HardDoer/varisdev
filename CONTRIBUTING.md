# Contributing to VarisDev

VarisDev is a desktop application distributed from this repository. Changes need to work for users with a fresh installation as well as existing accounts, plugins, and conversations.

## Development setup

Use Node.js 24.15+ on the 24.x line or 26+, npm 12, and Git. Clone this repository, then run from its directory:

```sh
npm ci
npm run desktop:dev
```

Installation includes the session runtime and compiles the desktop and command. A separate Pi installation is unnecessary.

## Use isolated data

For development and manual testing, point both `PI_CODING_AGENT_DIR` and `VARISDEV_DATA_DIR` at temporary directories. The first contains model accounts, settings, plugins, and conversations; the second contains desktop preferences and staged application updates. Set `PI_OFFLINE=1` when testing without model or update network requests.

Use test accounts and temporary projects. Keep your installed app's package registration separate from the checkout. The automated installation tests create their own temporary directories.

## Checks

```sh
npm run lint
npm run typecheck
npm run desktop:build
npm test
```

Electron tests require a graphical desktop. On a Linux machine without a display, run the suite with `xvfb-run -a npm test`. Tests without a display skip graphical scenarios.

Add checks for behavior that can regress, especially installation, plugin loading, account persistence, updates, and conversation state. Verify changes to the interface at narrow window sizes, with zoom, with keyboard navigation, and with reduced motion where relevant.

Run the production installation check through `npm test` so it uses your npm 12 executable. It installs from a Git repository into an isolated directory with production dependencies and an automatically generated desktop build. Update checks cover the full application, bundled dependencies, and failed installations retaining the working version. Tests must not modify a contributor's installed app or accounts.

## Changes and reports

Describe the behavior users see, how you verified it, and any changes to public commands or saved settings. Preserve user data when changing formats. Keep Pi details in internal implementation and extension documentation; normal commands and interface text use VarisDev.

For bug reports, include the VarisDev version, operating system, installation method, and steps to reproduce. Startup details are in `desktop/startup.log` under the VarisDev data directory.
