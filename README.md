# Varisware Pi/pidev plugins

Varisware VarisDev package.

## Included

- `extensions/varisdev.ts` — replaces the startup header with the Varisware ASCII logo, keeps the tab/window title set to `VarisDev - <folder>`, uses a small crow image-style loader with animated processing dots while the assistant is streaming, and registers VarisDev tools.
- `src/tools/http-request.ts` — agent-callable `http_request` tool for HTTP/HTTPS requests.
- `src/tools/openai-image.ts` — agent-callable `openai_generate_image` tool that generates images with the OpenAI Images API and saves them to files.
- `themes/varisware.json` — Varisware purple terminal theme.

## OpenAI image tool

Configure the API key through the environment before starting Pi:

```bash
export OPENAI_API_KEY="sk-..."
```

The image model is fixed to `gpt-image-2`. Dimensions can be requested per tool call via the `size` argument. Image quality is a tool parameter that the agent can choose from the user's request, defaulting to `auto` when unspecified.

Optional defaults:

```bash
export OPENAI_IMAGE_SIZE="1024x1024"
export OPENAI_IMAGE_OUTPUT_DIR="generated-images"
```

## Local test

```bash
npm install
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
