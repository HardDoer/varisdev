import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {loaderContextFiles} from './context-files.ts';
import {nativeCommands} from './command-catalog.mjs';

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
  scopedModels?: Array<{
    model: {id: string; provider: string; name: string};
    thinkingLevel?: string;
  }>;
  model?: {id: string; provider: string};
  thinkingLevel: string;
  thinkingLevels: string[];
  tools: Array<{name: string; description: string}>;
  diagnostics: Array<{message: string; path?: string}>;
}

export interface SessionConfiguration {
  persist?: boolean;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export const desktopCommands: SessionFeatures['commands'] = nativeCommands.map(
  ({name, description}) => ({name, description, source: 'builtin'}),
);

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
      .getAvailable()
      .map(model => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
      })),
    scopedModels: session.scopedModels.map(({model, thinkingLevel}) => ({
      model: {id: model.id, provider: model.provider, name: model.name},
      ...(thinkingLevel !== undefined ? {thinkingLevel} : {}),
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
