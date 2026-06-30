# Varisware Pi/pidev plugins

Varisware VarisDev package.

## Included

- `extensions/varisdev.ts` — replaces the startup header with the Varisware ASCII logo, keeps the tab/window title set to `VarisDev - <folder>`, uses a small crow image-style loader with animated processing dots while the assistant is streaming, and registers VarisDev tools.
- `src/tools/http-request.ts` — agent-callable `http_request` tool for HTTP/HTTPS requests.
- `src/tools/openai-image.ts` — agent-callable `openai_image` tool that creates or edits images with the OpenAI Images API and saves them to files.
- `themes/varisware.json` — Varisware purple terminal theme.

## OpenAI image tool

Configure the API key through the environment before starting Pi:

```bash
export OPENAI_API_KEY="sk-..."
```

The image model is fixed to `gpt-image-2`. Dimensions can be requested per tool call via the `size` argument. Image quality is a tool parameter that the agent can choose from the user's request, defaulting to `auto` when unspecified.

The `openai_image` tool can also use existing local PNG, JPEG, or WebP images by passing `inputImagePaths`, an array of up to 16 local file paths. Tool callers should pass local paths only, not raw base64 strings. The tool reads each file, converts it internally to a base64-backed OpenAI upload payload, and sends an edit request with one or more input images instead of a pure generation request.

Optional defaults:

```bash
export OPENAI_IMAGE_SIZE="1024x1024"
export OPENAI_IMAGE_OUTPUT_DIR="generated-images"
```

## Development

This repo targets Node.js 24+ and uses Google's TypeScript Style via `gts`.

```bash
npm run lint
npm run typecheck
npm run fix
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
