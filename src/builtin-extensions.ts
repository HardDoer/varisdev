import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
  type McpExtensionOptions,
} from '@earendil-works/pi-coding-agent';
import {LLAMA_PROVIDER, officialLlamaExtension} from './llama.ts';
import {registerApprovalCommand} from './agents/approval-ui.ts';

/** Match Pi's built-in identities so settings and replacements still apply. */
export function createBuiltinExtensions(
  options: {
    mcp?: McpExtensionOptions;
  } = {},
): InlineExtension[] {
  return [
    {
      name: 'varisdev-approvals',
      factory: registerApprovalCommand,
      builtin: true,
    },
    {
      name: LLAMA_PROVIDER,
      factory: officialLlamaExtension,
      builtin: true,
    },
    {
      name: 'codemode',
      factory: createCodemodeExtension(),
      builtin: true,
      replaceable: true,
    },
    {
      name: 'tool-search',
      factory: createToolSearchExtension(),
      builtin: true,
      replaceable: true,
    },
    {
      name: 'mcp',
      factory: createMcpExtension(options.mcp),
      builtin: true,
      replaceable: true,
    },
  ];
}
