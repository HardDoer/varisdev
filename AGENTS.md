# Versioning

- After completing a set of changes that differs from the default branch (`main`, or `master` in this repository), ensure the application version is higher than the version on that branch. Reuse an appropriate existing bump for the same set of changes.
- Follow semantic versioning (`MAJOR.MINOR.PATCH`): increment `PATCH` for compatible bug fixes and small changes, `MINOR` for compatible new features, and `MAJOR` for incompatible changes. Use the highest required level in the set and reset lower components to zero.
- Complete all code and documentation edits, resolve review findings, and pass required checks before bumping the version. Commit the completed changes so the working tree is clean, then run `npm version` as the final change in the set. The version tag must include the entire set of changes.
- Use `npm version <patch|minor|major>` to update `package.json` and `package-lock.json` together and create the version commit and Git tag. Keep `git-tag-version` enabled; never use `--no-git-tag-version` or set `git-tag-version=false`. Never edit lockfiles manually.

# Verification

- Keep verification proportional to the change and use the existing test harness where available.
- Every verification command must have an enforced process timeout. A timed-out check must terminate its child processes too; do not rely only on a tool-call timeout or launch an unbounded synchronous Electron process.
- Report a timeout or stalled check immediately. Investigate the failure before retrying, and stop once the relevant checks pass.

# Tool authentication

- Plugins may define their own configuration, authentication, and service APIs independently of Pi's LLM providers. Do not force a plugin through LLM account or model-selection mechanisms. Check and preserve the plugin's existing contract before changing shared infrastructure.
- `openai_image` generation and editing use the OpenAI Images API with `OPENAI_API_KEY` only. Do not introduce another image credential variable or fall back to Accounts credentials. ChatGPT/ChatPass sign-in and image API-key access are independent.
- Authentication checks must cover the affected launch environment and credential selection, including a missing environment key with a saved OAuth login. A test that injects a valid key and mocks a successful response does not cover that failure.

# Settings and environment variables

- Apply this precedence consistently: an explicitly saved user value takes precedence over the machine environment; removing the saved value restores the environment fallback.
- Reading or displaying an environment fallback must never persist it. Only an explicit user edit writes a value to the settings JSON; removing a value deletes that entry.
- Show environment fallback values in a muted style with a clear source label. Keep them editable so the user can save a replacement. Hide all environment field values by default and provide a Show/Hide control, including for names that do not look sensitive.
- Load the required shell environment at app startup, including `.zshrc`, for desktop and terminal launches. Keep credentials out of logs and bound shell startup with process-tree cleanup.

# Layout

- All main elements must remain visible without page scrolling. Content inside an element may scroll.
- When space is minimal, panels may move into drawers. Keep a clearly labeled, visible control for opening each drawer, and preserve access to its information and actions.
- Apply this convention at smaller window sizes and supported zoom levels. Reflow and tighten spacing before allowing controls or panels to be clipped.
- Give the live scene enough space to remain readable and clickable. Keep session information and actions accessible from its compact controls.
- Review actual rendered screenshots for clipping, overlap, readable content, and usable scene size. Geometry checks alone do not establish that a layout works.

# Pi interfaces

- Show Pi features through Pi's shipped terminal components, using the Model/Thinking menu's terminal dialog bridge as the reference.
- Preserve Pi's rendering, keyboard handling, search, submenus, and available options. Do not recreate Pi menus in HTML or maintain a separate list of their settings.
- Keep adapters limited to desktop hosting, session callbacks, sizing, focus, cancellation, and cleanup. Use Pi's settings and session APIs for changes. If a view is only available through a shipped Pi handler, host that handler through a small adapter rather than copying its menus or field lists.
- Verify the wrapper and its integration with the active session, including compact layouts and cancellation; do not duplicate tests of Pi's components.

# UI text

- Make UI elements and scene objects understandable through their appearance, placement, and behavior. Avoid decorative labels and unexplained abbreviations such as “LEAD” and “IN”.
- Avoid redundant UI notes that explain obvious behavior or internal implementation details, such as “Choices follow Pi’s Scoped models.” Include notes only when they help the user make a decision or understand a non-obvious constraint.

# Theme colors

- Review every alternate theme equally. Important controls, job states, robots, and effects must stand out clearly in each theme.
- Keep each theme’s background character, but use a varied, vivid accent palette. Do not tint all key elements toward the background’s dominant color. Factory is a reference for clear visual distinction.
- Keep job status meanings consistent across themes. Pair status colors with readable labels and distinct icons or shapes so color is never the only distinction.
- Check colors against their actual rendered backgrounds, including hover, selection, tinted panels, and layered effects. Target at least 4.5:1 contrast for normal text and 3:1 for controls, focus indicators, and meaningful graphics.
- Robots need a clear silhouette, a distinct visor, readable eyes, and visible status lights against the factory scene. Use contrasting materials, outlines, or backing surfaces where needed.
- Give different effects purposeful accent colors and enough separation from their surroundings. A theme must not turn every effect into the same color.
- Verify every shipped theme in the renderer as well as checking palette values. Include status distinctions, selected items, robot faces, and active effects in that review.

# Documentation

- Documentation is for users of the software. Describe features, installation, configuration, usage, and relevant limitations, including supported plugin interfaces.
- Do not add documents or sections about work in progress, individual bug fixes, regressions, implementation patches, benchmark results, test coverage, or development progress.
- Update existing user guides when functionality changes. Add a new page only when a user topic needs its own guide.

# README.md

- Keep the README concise and preserve its existing tone and level of detail.
- Do not add unnecessary implementation details, UI routing explanations, exhaustive command examples, or redundant explanations. If the existing wording already communicates the behavior, leave it alone.
- Put detailed user guides in `docs/`.
