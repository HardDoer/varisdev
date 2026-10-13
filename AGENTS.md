# Project notes for coding agents

- This repository is an ongoing personal development tool for the user.
- The user installs and runs this tool as a Pi package downloaded from GitHub (`pi install git:git@github.com:varisware/pidev-plugins`), not from this development checkout. Implement and verify changes for Pi's managed package installation, including runtime dependencies, packaged assets, and automatic desktop builds. User update instructions are `pi update` followed by restarting Pi; do not assume local checkout changes affect the installed tool or ask the user to run development npm commands.
- The user is the only consumer; prefer clean refactors over backward compatibility.
- Do not preserve legacy tool names, schemas, or compatibility shims unless explicitly requested.
