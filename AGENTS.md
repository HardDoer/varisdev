# Project notes for coding agents

- This repository is an ongoing personal development tool for the user.
- The user installs and runs this tool as a Pi package downloaded from GitHub (`pi install git:git@github.com:varisware/pidev-plugins`), not from this development checkout. Implement and verify changes for Pi's managed package installation, including runtime dependencies, packaged assets, and automatic desktop builds. User update instructions are `pi update` followed by restarting Pi; do not assume local checkout changes affect the installed tool or ask the user to run development npm commands.
- Keep the user's Pi package registration pointed at GitHub. Never replace it with this checkout for development or testing; use a temporary agent directory and an isolated package installation for verification.
- The user is the only consumer; prefer clean refactors over backward compatibility.
- Do not preserve legacy tool names, schemas, or compatibility shims unless explicitly requested.
