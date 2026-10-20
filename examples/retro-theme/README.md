# Retro themes

This package adds two app themes:

- **Retro desktop** uses the Year1998 desktop appearance and office scene.
- **Retro control room** uses that appearance with a custom Canvas2D renderer.

Copy this directory, then install it in a project:

```sh
varisdev install /absolute/path/to/retro-theme --local
```

Run `/reload` and choose a theme from **Menu → Theme**.

Edit `themes/retro.json` for a starter built on Year1998. Edit `themes/control-room.json` and `themes/scene.js` to replace the scene. `retro.css` references `grid.svg` with a relative URL.

The custom scene draws parent and agent workstations with status text and lights, reports label anchors, and selects units when clicked. It receives the sessions collection through `updateHub`. Prompt and attention actions show a banner; the cane triggers shared damage and replacement behavior. Motion follows the app setting, and disposal releases observers, listeners, frames, and controllers.

Scene modules export `apiVersion = 1` and a synchronous `createScene`. The host supplies shared controllers through `options.helpers`, so this example needs no browser imports or build step. For larger renderers, bundle browser dependencies into one module of at most 2 MiB. Reopen the Theme menu to discover edited module and stylesheet content. See the [scene API](../../docs/plugins.md#custom-scene-modules) for types and lifecycle details.
