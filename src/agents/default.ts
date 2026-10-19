import {builtinDefaultAgentPath} from '../builtin-assets.ts';
import type {AgentTemplate} from './templates.ts';

/** The selected agent for a regular Pi session; adds no prompt or policy. */
export function createDefaultAgentProfile(): AgentTemplate {
  return {
    id: 'default',
    key: 'builtin:default',
    name: 'Default',
    mode: 'all',
    context: 'workspace',
    instructions: '',
    permissions: [],
    hidden: false,
    disabled: false,
    scope: 'builtin',
    sourcePath: builtinDefaultAgentPath,
  };
}
