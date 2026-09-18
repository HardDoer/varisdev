import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerBrowseTool} from './browse.ts';
import {registerDownloadTool} from './download.ts';
import {registerGameMakerQueryTool} from './gamemaker-query.ts';
import {registerImageQueryTool} from './image-query.ts';
import {registerJsonQueryTool} from './json-query.ts';
import {registerOpenAIImageTool} from './openai-image.ts';

/** Register the project tools available in each session. */
export function registerProjectTools(pi: ExtensionAPI): void {
  registerBrowseTool(pi);
  registerDownloadTool(pi);
  registerGameMakerQueryTool(pi);
  registerImageQueryTool(pi);
  registerJsonQueryTool(pi);
  registerOpenAIImageTool(pi);
}
