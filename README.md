# Varisware Pi/pidev plugins

Private Varisware Pi package.

## Included

- `extensions/varisterminal.ts` — replaces the startup header with the Varisware ASCII logo, sets the terminal title to `VarisTerminal`, and uses a raven ASCII avatar while the assistant is streaming.
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
