import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerBrowseTool} from './browse.ts';
import {registerDownloadTool} from './download.ts';
import {registerGameMakerQueryTool} from './gamemaker-query.ts';
import {registerImageQueryTool} from './image-query.ts';
import {registerImagePreviewTool} from './image-preview.ts';
import {registerJsonQueryTool} from './json-query.ts';
import {registerOpenAIImageTool} from './openai-image.ts';

/** Project tools shared by the main session and its workers. */
export function registerProjectTools(pi: ExtensionAPI): void {
  registerBrowseTool(pi);
  registerDownloadTool(pi);
  registerGameMakerQueryTool(pi);
  registerImageQueryTool(pi);
  registerImagePreviewTool(pi);
  registerJsonQueryTool(pi);
  registerOpenAIImageTool(pi);
}
