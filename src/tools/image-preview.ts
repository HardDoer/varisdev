import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import sharp from 'sharp';
import {Type} from 'typebox';
import {readPreviewImage, resolveImagePath} from '../image-preview/files.ts';

const schema = Type.Object({
  path: Type.String({
    description:
      'Local image path to show in the conversation. Relative paths resolve under the current project; @ is optional.',
  }),
});

export function registerImagePreviewTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'image_preview',
    label: 'Image Preview',
    description:
      'Show a local image in the conversation with an interactive terminal preview. Supports PNG, JPEG, GIF, WebP, AVIF, SVG, and TIFF.',
    promptSnippet:
      'Show an existing image to the user directly in the terminal.',
    promptGuidelines: [
      'Use image_preview when showing an existing image, screenshot, chart, or visual result to the user. Pass its real local path.',
      'openai_image output is previewed automatically; an additional image_preview call is unnecessary after generation.',
      'For Markdown image links, use actual local paths. Do not invent sandbox URLs or embed base64 in messages.',
    ],
    parameters: schema,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const path = resolveImagePath(params.path, ctx.cwd);
      if (!path) throw new Error('Unsupported local image path.');
      const bytes = await readPreviewImage(path);
      const metadata = await sharp(bytes, {
        limitInputPixels: 40_000_000,
      }).metadata();
      signal?.throwIfAborted();
      return {
        content: [
          {
            type: 'text',
            text: `Image preview: ${path} (${metadata.width}×${metadata.height}, ${metadata.format})`,
          },
        ],
        details: {
          images: [{path, width: metadata.width, height: metadata.height}],
        },
      };
    },
  });
}
