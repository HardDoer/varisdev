# Project notes for coding agents

- VarisDev is a distributed open-source application for multiple users. Design installation, updates, defaults, error messages, and documentation for clean machines and public releases; do not assume the developer's environment or credentials.
- When the user gives several requests, create or update `PLAN.md` with a checklist of the requested work and verification. Keep it current as requests change and work is completed.
- Delegated agents inherit the user's selected parent model unless the user requests another model. Do not impose a provider or model.
- VarisDev is a standalone app installed from GitHub (`npm install -g git+ssh://git@github.com/HardDoer/varisdev.git`) and launched with `varisdev`. Pi is an internal runtime; keep normal commands and UI branded VarisDev. `varisdev update` and the app's Updates menu update the full application and its bundled runtime. Verify production dependencies, packaged assets, and automatic builds outside this checkout. The package can also load as a Pi extension; keep that managed installation working. Do not assume checkout changes affect installed copies or ask users to run development npm commands.
- Keep the user's existing Pi package registration pointed at GitHub. Never replace it with this checkout for development or testing. Use temporary `PI_CODING_AGENT_DIR` and `VARISDEV_DATA_DIR` directories and an isolated package installation for verification.
- Use “agents” and “parent sessions” consistently in UI text, logs, and documentation.
- Let controls, layout, and interaction guide the user. Avoid redundant explanatory labels and notes that repeat what the UI already communicates.
- Consider existing installations and saved user data when changing public commands, settings, or package formats. Keep internal refactors clean, and document deliberate public interface changes.
- Do not introduce legacy tool names, schemas, or compatibility shims without a concrete installed-user need.
