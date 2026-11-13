import {pinnedPiModuleURL} from './pi-shipped-modules.ts';

type PiSDK = typeof import('@earendil-works/pi-coding-agent');

export const {CONFIG_DIR_NAME, getAgentDir} = (await import(
  pinnedPiModuleURL('config.js').href
)) as Pick<PiSDK, 'CONFIG_DIR_NAME' | 'getAgentDir'>;
