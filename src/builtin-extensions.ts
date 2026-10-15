import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent';

/** Match Pi's built-in identities so settings and replacements still apply. */
export function createBuiltinExtensions(): InlineExtension[] {
  return [
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
      factory: createMcpExtension(),
      builtin: true,
      replaceable: true,
    },
  ];
}
