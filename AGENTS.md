# Verification

- Keep verification proportional to the change and use the existing test harness where available.
- Every verification command must have an enforced process timeout. A timed-out check must terminate its child processes too; do not rely only on a tool-call timeout or launch an unbounded synchronous Electron process.
- Report a timeout or stalled check immediately. Investigate the failure before retrying, and stop once the relevant checks pass.

# Layout

- All main elements must remain visible without page scrolling. Content inside an element may scroll.
- When space is minimal, panels may move into drawers. Keep a clearly labeled, visible control for opening each drawer, and preserve access to its information and actions.
- Apply this convention at smaller window sizes and supported zoom levels. Reflow and tighten spacing before allowing controls or panels to be clipped.
- Give the live scene enough space to remain readable and clickable. Keep session information and actions accessible from its compact controls.
- Review actual rendered screenshots for clipping, overlap, readable content, and usable scene size. Geometry checks alone do not establish that a layout works.

# UI text

- Avoid redundant UI notes that explain obvious behavior or internal implementation details, such as “Choices follow Pi’s Scoped models.” Include notes only when they help the user make a decision or understand a non-obvious constraint.

# Theme colors

- Review every alternate theme equally. Important controls, job states, robots, and effects must stand out clearly in each theme.
- Keep each theme’s background character, but use a varied, vivid accent palette. Do not tint all key elements toward the background’s dominant color. Factory is a reference for clear visual distinction.
- Keep job status meanings consistent across themes. Pair status colors with readable labels and distinct icons or shapes so color is never the only distinction.
- Check colors against their actual rendered backgrounds, including hover, selection, tinted panels, and layered effects. Target at least 4.5:1 contrast for normal text and 3:1 for controls, focus indicators, and meaningful graphics.
- Robots need a clear silhouette, a distinct visor, readable eyes, and visible status lights against the factory scene. Use contrasting materials, outlines, or backing surfaces where needed.
- Give different effects purposeful accent colors and enough separation from their surroundings. A theme must not turn every effect into the same color.
- Verify every shipped theme in the renderer as well as checking palette values. Include status distinctions, selected items, robot faces, and active effects in that review.

# README.md

- Keep the README concise and preserve its existing tone and level of detail.
- Do not add unnecessary implementation details, UI routing explanations, exhaustive command examples, or redundant explanations. If the existing wording already communicates the behavior, leave it alone.
- Put detailed technical documentation in `docs/`.
