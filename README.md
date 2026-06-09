# Varisware Pi/pidev plugins

Varisware VarisDev package.

## Included

- `extensions/varisdev.ts` — replaces the startup header with the Varisware ASCII logo, keeps the tab/window title set to `VarisDev - <folder>`, uses a crow ASCII avatar while the assistant is streaming, and prefixes assistant replies with ANSI-colored crow block art.
- `themes/varisware.json` — Varisware purple terminal theme.

## Local test

```bash
pi -e ./extensions/varisdev.ts
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
/varisdev
```
