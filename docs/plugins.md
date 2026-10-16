# Visuals and themes from plugins

VarisDev loads installed extension packages in parent sessions and agents. A plugin can add conversation visuals or a selectable app theme using the formats below.

The [project board example](../examples/project-board/) provides a tool, a `/project-board` command, and an Ink theme. Copy that directory to a location of your choice, then install it:

```sh
varisdev install /absolute/path/to/project-board --local
```

Use **Menu → Model defaults → Current session → Reload skills & extensions** in an idle parent session. Ask for `project_board`, or run `/project-board PLAN.md`. Open **Menu → Theme** to choose Ink. Agents load the project's installed plugins when they start.

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

Version 1 accepts up to eight blocks, 16,000 characters per Markdown block, and 200 characters per label. Unsupported versions, malformed fields, and excess blocks produce visible diagnostics alongside any usable content. Images use local files. PNG, JPEG, GIF, WebP, AVIF, SVG, and TIFF are supported; animated and multipage files show their first frame or page. Input limits are 50 MiB and 40 million pixels. SVG is rasterized before display. Thumbnails are at most 640 pixels per edge; larger views at most 2560. Image references and decoded images use bounded caches, and missing files can be retried. Keep files available when reopening saved conversations.

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

Each file describes a palette and optionally a stylesheet:

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

`base` is `factory`, `nord`, `dracula`, `catppuccin-mocha`, `forest`, `moss`, `kimbie-dark`, `solarized-light`, `mint-paper`, `glacier`, `rose-quartz`, or `high-contrast`. Omitted colors inherit from the base. Colors use six digit hex values. The interface palette also supplies matching factory colors; optional `scenePalette` overrides individual scene colors.

Available interface colors are `bg`, `panel`, `panel-raised`, `input`, `line`, `text`, `muted`, `mint`, `cyan`, `amber`, `red`, `violet`, `rose`, `focus`, `accent-text`, `hover`, `selected`, `selection-bg`, `selection-text`, `selection-border`, `status-running`, `status-queued`, `status-completed`, `danger`, `scene`, `scene-glow`, and `page-glow`.

Role colors are `accent` (buttons and active controls), `link`, `heading`, `code`, `message-user`, `message-assistant`, `action-read`, `action-edit`, `action-command`, `action-web`, `action-agent`, `action-media`, `diff-add`, and `diff-remove`. These can vary independently. `accent-text` is the text on filled accent buttons. Legacy named palette overrides provide role defaults; explicit role colors take precedence. Links use a legacy `cyan` override before `mint`.

Scene overrides are `floor`, `edge`, `dark`, `metal`, `shell`, `white`, `mint`, `cyan`, `amber`, `red`, `dim`, `screen`, `selection`, `running`, `queued`, and `completed`.

Stylesheets are relative to the theme file and must remain inside the installed package. They can use the interface's CSS variables and style app elements. Their CSS is applied while that theme is selected and removed when switching. Keep keyboard focus, readable text, and reduced-motion preferences usable in your styles.

The menu discovers themes from global plugins and the selected project's plugins, without executing their extension code. Theme IDs include the package name to avoid collisions. Opening the menu refreshes discovery; invalid entries appear under **Theme errors**. Each manifest, theme, or stylesheet is limited to 128 KB, with up to 64 registrations. The selected theme is saved across restarts. Removing its plugin falls back to Factory.
