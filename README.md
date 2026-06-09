# Varisware Pi/pidev plugins

Varisware coding terminal package.

## Included

- `extensions/varisterminal.ts` — replaces the startup header with the Varisware ASCII logo, keeps the tab/window title set to `VWTerminal - <folder>`, and uses a crow ASCII avatar while the assistant is streaming.
- `themes/varisware.json` — Varisware purple terminal theme.

## Local test

```bash
pi -e ./extensions/varisterminal.ts
```

## Install from this repo

```bash
pi install git:git@github.com:varisware/pidev-plugins
```

Pin a tag or commit when sharing with the team:

```bash
pi install git:git@github.com:varisware/pidev-plugins@v0.1.0
```

If needed, reapply branding inside Pi with:

```txt
/varisterminal
```
