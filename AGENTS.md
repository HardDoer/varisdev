# Project notes for coding agents

- This repository is an ongoing personal development tool for the user.
- Use GPT-6.1-Sol (`openai-codex/gpt-6.1-sol`) for delegated agents. Do not use Astra agents or inherit an Astra model when spawning agents.
- The user installs and runs this tool as a Pi package downloaded from GitHub (`pi install git:github.com/HardDoer/varisdev`), not from this development checkout. Implement and verify changes for Pi's managed package installation, including runtime dependencies, packaged assets, and automatic desktop builds. User update instructions are `pi update` followed by restarting Pi; do not assume local checkout changes affect the installed tool or ask the user to run development npm commands.
- Keep the user's Pi package registration pointed at GitHub. Never replace it with this checkout for development or testing; use a temporary agent directory and an isolated package installation for verification.
- Use “agents” and “parent sessions” consistently in UI text, logs, and documentation.
- Let controls, layout, and interaction guide the user. Avoid redundant explanatory labels and notes that repeat what the UI already communicates.
- The user is the only consumer; prefer clean refactors over backward compatibility.
- Do not preserve legacy tool names, schemas, or compatibility shims unless explicitly requested.
