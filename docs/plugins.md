# Visuals and themes from plugins

VarisDev loads installed extension packages in parent sessions and agents. A plugin can add conversation visuals or a selectable app theme using the formats below.

The [project board example](../examples/project-board/) provides a tool, a `/project-board` command, and an Ink theme. Copy that directory to a location of your choice, then install it:

```sh
varisdev install /absolute/path/to/project-board --local
```

Run `/reload` to load the plugin. Ask for `project_board`, or run `/project-board PLAN.md`. Open **Menu → Theme** to choose Ink. Agents load the project's installed plugins when they start.

## Conversation visuals

Return ordinary tool text for the model and put the visualization in `details.varisdev`:

```js
return {
  content: [{type: 'text', text: 'Rendered 3 of 5 scenes.'}],
  details: {
    varisdev: {
      version: 1,
      blocks: [
        {type: 'progress', value: 3, total: 5, label: 'Scenes'},
        {
          type: 'markdown',
          text: '## Preview\n- [x] Lighting\n- [ ] Final render',
        },
        {
          type: 'image',
          path: '/absolute/path/to/preview.png',
          label: 'Scene preview',
        },
      ],
    },
  },
};
```

This is plain JSON and requires no VarisDev dependency. It works with live tool updates, final results, and displayed custom messages:

```js
api.sendMessage({
  customType: 'render-status',
  content: 'Rendered 3 of 5 scenes.',
  display: true,
  details: {varisdev: {version: 1, blocks}},
});
```

The same blocks appear in parent and agent conversations, including restored history. Plugins keep their existing execution and model-facing tool results.

| Block      | Fields                                | Display                                                                                                            |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `image`    | `path`, optional `label`              | Lazy thumbnail; click for a larger view. Relative paths use the session's project folder.                          |
| `markdown` | `text`                                | Headings, lists, checkboxes, code, and links through the app's safe Markdown renderer. HTML remains text.          |
| `progress` | `value`, optional `total` and `label` | Progress bar with a readable value. `total` defaults to `1` and must be positive. Values are clamped to the range. |

Version 1 accepts up to eight blocks, 16,000 characters per Markdown block, and 200 characters per label. Unsupported versions, malformed fields, and excess blocks produce visible diagnostics alongside any usable content. Images use local files. PNG, JPEG, GIF, WebP, AVIF, SVG, and TIFF are supported; animated and multipage files show their first frame or page. Input limits are 50 MiB and 40 million pixels. SVG is rasterized before display. Thumbnails are at most 640 pixels per edge; larger views at most 2560. Missing files can be retried. Keep files available when reopening saved conversations.

Normal image attachments and tool results with `details.images: [{path}]` are also displayed. An explicit image block and the same path in `details.images` produce one preview. `image_preview` uses the contract above; `openai_image` output is displayed automatically.

### Optional helpers and types

For projects that already depend on VarisDev, `varisdev/visualizations` exports:

```ts
import {visualResult, visualizationDetails} from 'varisdev/visualizations';
import type {
  VisualizationBlock,
  VisualizationMetadata,
} from 'varisdev/visualizations';

const blocks: VisualizationBlock[] = [
  {type: 'progress', value: 1, total: 2, label: 'Build'},
];
return visualResult('Build is halfway complete.', blocks);
// visualizationDetails(blocks) returns {varisdev: {version: 1, blocks}}.
```

Use the JSON format directly when your plugin has no app dependency.

## App themes

Add theme files to the installed package's manifest:

```json
{
  "name": "my-plugin",
  "varisdev": {"themes": ["./themes/my-theme.json"]}
}
```

Each file describes a palette and can also choose an appearance, stylesheet, or scene renderer:

```json
{
  "id": "midnight",
  "name": "Midnight",
  "base": "nord",
  "colors": {
    "bg": "#121c2b",
    "accent": "#a0f0d0",
    "message-assistant": "#e9c989",
    "action-command": "#c9a7e8",
    "focus": "#e9c989"
  },
  "stylesheet": "./midnight.css"
}
```

`base` is `factory`, `year1998`, `nord`, `dracula`, `catppuccin-mocha`, `forest`, `moss`, `kimbie-dark`, `solarized-light`, `mint-paper`, `glacier`, `rose-quartz`, or `high-contrast`. Omitted colors inherit from the base. Colors use six digit hex values. The interface palette also supplies matching factory colors; optional `scenePalette` overrides individual scene colors.

Available interface colors are `bg`, `panel`, `panel-raised`, `input`, `line`, `text`, `muted`, `mint`, `cyan`, `amber`, `red`, `violet`, `rose`, `focus`, `accent-text`, `hover`, `selected`, `selection-bg`, `selection-text`, `selection-border`, `danger`, `scene`, `scene-glow`, and `page-glow`.

Status colors are `status-running` (green), `status-queued` (amber), `status-completed` (blue), `status-failed` (red), `status-cancelling` (orange), `status-compacting` (violet), and `status-cancelled` (neutral). Badges also have distinct symbols and text labels.

Robot colors are `robot-shell`, `robot-outline`, `robot-screen`, and `robot-eyes`. Keep the silhouette distinct from its surroundings, the visor distinct from the shell, and the eyes readable against the visor.

Role colors are `accent` (buttons and active controls), `link`, `heading`, `code`, `message-user`, `message-assistant`, `action-read`, `action-edit`, `action-command`, `action-web`, `action-agent`, `action-media`, `diff-add`, and `diff-remove`. These can vary independently. `accent-text` is the text on filled accent buttons. Legacy named palette overrides provide role defaults; explicit role colors take precedence. Links use a legacy `cyan` override before `mint`.

Scene overrides are `floor`, `edge`, `dark`, `metal`, `shell`, `outline`, `eyes`, `white`, `mint`, `cyan`, `amber`, `red`, `violet`, `rose`, `dim`, `screen`, `selection`, `running`, `queued`, `completed`, `failed`, `cancelling`, `compacting`, and `cancelled`.

Use a varied accent palette for important controls, robots, and effects rather than tinting everything toward the background color. Check the rendered hover and selection states too: normal text needs at least 4.5:1 contrast, and controls, focus indicators, and meaningful graphics need 3:1.

Stylesheets are relative to the theme file and must remain inside the installed package. They can use the interface's CSS variables and style app elements. The app loads a stylesheet through a file URL so relative assets such as `url('./wallpaper.svg')` resolve beside it. Content hashes refresh changed stylesheets when discovery runs. Their CSS is applied while that theme is selected and removed when switching. Keep keyboard focus and reduced-motion preferences usable in your styles.

### Appearance and scenes

`appearance` accepts `default` or `year1998`. It controls the app's visual treatment, including window frames, controls, and typography. Omitting it inherits the base theme's appearance. `scene` accepts `factory`, `year1998`, or a custom module registration; omitting it inherits the base theme's scene. These choices can be combined with palette overrides and a stylesheet:

```json
{
  "id": "retro",
  "name": "Retro control room",
  "base": "year1998",
  "appearance": "year1998",
  "scene": {"module": "./scene.js", "apiVersion": 1},
  "stylesheet": "./retro.css"
}
```

The [retro theme example](../examples/retro-theme/) includes a Year1998 starter and a custom Canvas2D control room with selection, status lights, motion, prompt reactions, and cane damage.

### Custom scene modules

A scene module is a browser ES module relative to the theme JSON. Its canonical path must stay inside the installed package, including through symbolic links. Bundle the renderer and its dependencies into a module of at most 2 MiB. Discovery reads and validates the registration without executing it. The selected scene is imported using a file URL with a content hash, so changes to that module load again after discovery.

Export `apiVersion = 1` and a synchronous `createScene(canvas, options)` function:

```js
export const apiVersion = 1;

export function createScene(canvas, {apiVersion, onSelect, onLayout, helpers}) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas2D is unavailable');
  return {
    update(snapshot, selectedId) {
      /* draw session and agent state */
    },
    setPalette(palette) {
      /* RGB arrays, each component between 0 and 1 */
    },
    setMotion(enabled) {
      /* honor motion preference */
    },
    dispose() {
      /* release listeners, observers, frames, graphics resources */
    },
  };
}
```

`options.apiVersion` is `1`. `onSelect(id)` selects `parent` or an agent ID. `onLayout(anchors)` reports robot positions for the app's activity effects and accessible selection controls using `{id, x, y, visible, away?, detail?}`; `x` and `y` are normalized canvas coordinates. Do not use parent session IDs for selection: the current session's selection ID is `parent`.

The required methods are `update(snapshot, selectedId)`, `setPalette(palette)`, `setMotion(enabled)`, and `dispose()`. A snapshot contains `session` and `agents`; it can be `null` before a session is available. Palette values are RGB triples in the range 0–1, keyed by the scene colors listed above.

Optional hooks provide these actions:

| Method                                          | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `updateHub(hub)`                                | Receive the current sessions collection, or `null`.              |
| `prompt(sessionId)` / `cancelPrompt(sessionId)` | React to prompt submission or cancellation for a parent session. |
| `startle(animate = true)` / `clearStartle()`    | Show and clear the app's attention reaction.                     |
| `caneTargets()`                                 | Return `{id, x, y, radius}` targets in viewport CSS pixels.      |
| `hitWithCane(id, direction = 1, strength = 1)`  | React to a target hit; return whether it was accepted.           |

`options.helpers` supplies `createParentMotion`, `createFactoryVisitors`, `visitorCaneId`, `createRobotDamage`, `createRobotWhip`, `factoryIdentity`, and `factoryIdentityPalette`. These share the built-in scene's motion, visitors, damage, and session identity behaviors. The controllers schedule no frames; call their `tick(seconds)` methods from your scene's animation loop, forward motion preferences, and dispose them with the scene.

The host imports modules asynchronously and calls `createScene` synchronously. When switching renderers it replaces the canvas and replays the current snapshot, selection, hub, palette, and motion preference. Release acquired resources before throwing during creation, and release remaining resources in `dispose()`. Load or API errors appear under **Theme errors**, with Factory used as the scene fallback.

Modules run in the desktop renderer with browser APIs and the app's existing content security policy. Node APIs are unavailable. Scene modules have access to the desktop bridge.

Optional TypeScript types are available without importing the agent SDK:

```ts
import type {
  ThemeSceneModule,
  ThemeScene,
  ThemeSceneOptions,
} from 'varisdev/theme-renderers';
```

Use `ThemeSceneModule['createScene']` as the factory's type. `ThemeSceneRegistration` describes the theme JSON's `scene` field. `ThemeSceneReference` describes the resolved registration delivered to the renderer; custom registrations contain `moduleUrl` and `apiVersion` there. The public snapshot types expose stable scene fields and use `unknown` for additional data.

The menu lists themes from global plugins and the selected project's plugins. Theme IDs include the package name to avoid collisions. Opening the menu refreshes discovery; invalid entries appear under **Theme errors**. Each manifest, theme, or stylesheet is limited to 128 KB; a scene module is limited to 2 MiB, with up to 64 theme registrations. The selected theme is saved across restarts. Removing its plugin falls back to Factory.
