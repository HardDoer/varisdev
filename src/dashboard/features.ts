import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {loaderContextFiles} from './context-files.ts';

// Use the public entry so Pi can supply its API through the extension loader.
export function supportedThinkingLevels(
  model: NonNullable<CreateAgentSessionOptions['model']>,
): string[] {
  return getSupportedThinkingLevels(model);
}

export interface SessionFeatures {
  contextFiles?: Array<{
    path: string;
    name: string;
    kind:
      'instructions' | 'system' | 'append' | 'skill' | 'template' | 'document';
    status: 'included' | 'available';
    description: string;
    content?: string;
  }>;
  commands: Array<{
    name: string;
    description: string;
    source: 'skill' | 'prompt' | 'extension' | 'builtin';
    path?: string;
  }>;
  models: Array<{id: string; provider: string; name: string}>;
  model?: {id: string; provider: string};
  thinkingLevel: string;
  thinkingLevels: string[];
  tools: Array<{name: string; description: string}>;
  diagnostics: Array<{message: string; path?: string}>;
}

export interface SessionConfiguration {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export const desktopCommands: SessionFeatures['commands'] = [
  {
    name: 'compact',
    description: 'Compact conversation history, with optional instructions.',
    source: 'builtin',
  },
  {
    name: 'reload',
    description: 'Reload extensions, skills, prompts and settings.',
    source: 'builtin',
  },
  {
    name: 'model',
    description: 'Select a model using provider/model.',
    source: 'builtin',
  },
  {name: 'thinking', description: 'Set the thinking level.', source: 'builtin'},
  {
    name: 'session',
    description: 'Show information about this conversation.',
    source: 'builtin',
  },
  {name: 'name', description: 'Name this conversation.', source: 'builtin'},
];

export function sessionFeatures(
  session: AgentSession,
  loader: ResourceLoader,
  settings: SettingsManager,
  diagnostics: SessionFeatures['diagnostics'] = [],
): SessionFeatures {
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const extensions = loader.getExtensions();
  const runner = session.extensionRunner;
  return {
    contextFiles: loaderContextFiles(
      loader,
      session.getActiveToolNames(),
      session.sessionManager.buildSessionContext().messages,
      session.sessionManager.getCwd(),
    ),
    commands: [
      ...desktopCommands.map(command => ({...command})),
      ...runner
        .getRegisteredCommands()
        .map(command => ({
          name: command.invocationName,
          description: command.description ?? '',
          source: 'extension' as const,
          path: command.sourceInfo.path,
        }))
        .filter(
          command =>
            !desktopCommands.some(builtin => builtin.name === command.name),
        ),
      ...prompts.prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        source: 'prompt' as const,
        path: prompt.filePath,
      })),
      ...(settings.getEnableSkillCommands()
        ? skills.skills.map(skill => ({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: 'skill' as const,
            path: skill.filePath,
          }))
        : []),
    ],
    models: runner
      .getModelRegistry()
      .getAll()
      .map(model => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
      })),
    ...(session.model
      ? {model: {id: session.model.id, provider: session.model.provider}}
      : {}),
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
    tools: session
      .getAllTools()
      .map(tool => ({name: tool.name, description: tool.description})),
    diagnostics: [
      ...skills.diagnostics,
      ...prompts.diagnostics,
      ...loader.getThemes().diagnostics,
      ...runner.getCommandDiagnostics(),
      ...extensions.errors.map(error => ({
        message: error.error,
        path: error.path,
      })),
      ...diagnostics,
    ].map(({message, path}) => ({message, ...(path ? {path} : {})})),
  };
}
