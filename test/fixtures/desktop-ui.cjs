/* global process, __dirname, document, requestAnimationFrame, setTimeout, clearTimeout, console, localStorage,
   NodeFilter, Node, Event, KeyboardEvent, innerWidth, innerHeight, getComputedStyle, structuredClone, Storage, DOMException */
const assert = require('node:assert/strict');
const {mkdirSync, writeFileSync} = require('node:fs');
const {basename, join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, ipcMain} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: [], screenshots: []};
const at = '2026-01-01T12:00:00.000Z';
let hub;
let window;
let calls = [];
let rendererErrors = [];
let resources;
let featureRequests;
let featureDelays;
let featureGates;
let featureErrors;
let editorSubmission;
let chosenFolder;
let abortDelay = 0;
let cancellationError;
let savedSessions;
let archivedSessions;
let creationIds;
let creationDelay;
let creationError;
let closeDelay;
let closeError;
let resumeError;
let recentProjects;
let recentProjectsDelay;
let recentProjectsError;
let workspaceTemplateResponses;
let workspaceTemplateDelays;
let workspaceTemplateErrors;
let agentPromptError;
let agentPromptDelay;
let dialogDelays;
let dialogErrors;
let agentTemplates;
let defaultAgentId;
let defaultAgent;
let templateError;
let toolSettings;
let toolSettingsError;
let imageModel = '';
let resizeMouseIsolated = false;
let expectedResizeMouse = [];
let resizeNativeTrace = [];

function terminalMenuOutput(title, options, selection = 0) {
  return `\u001bc${title}\r\n${options
    .map((option, index) => `${index === selection ? '> ' : '  '}${option}`)
    .join('\r\n')}\r\n\r\n↑/↓ move · Enter select · Esc cancel`;
}

function fixtureToolSettings(allowedModels = null) {
  return {
    settings: {agents: {allowedModels, maxConcurrentAgents: 6}},
    models: [
      {provider: 'fixture', id: 'small', name: 'Fixture small'},
      {provider: 'fixture-other', id: 'large', name: 'Fixture large'},
    ],
  };
}

function features(agentProfile) {
  return {
    agentMentions: [
      {id: 'review', name: 'Review', description: 'Review changes'},
      {id: 'team/review', name: 'Team review', mention: '@agent:team/review'},
      {
        id: 'My Agent (Ä).test',
        name: 'My Agent (Ä).test',
        mention: '@agent:"My Agent (Ä).test"',
      },
      {
        id: 'Agent "Quoted"',
        name: 'Quoted agent',
        mention: '@agent:"Agent \\"Quoted\\""',
      },
      {id: 'Äänekäs', name: 'Äänekäs'},
      {id: '.Hidden.Agent', name: '.Hidden.Agent'},
    ],
    commands: [
      {
        name: 'skill:inspect',
        description: 'Inspect the selected files',
        source: 'skill',
        path: '/fixture/skills/inspect/SKILL.md',
      },
      {
        name: 'review',
        description: 'Review the current diff',
        source: 'prompt',
      },
      {
        name: 'fixture-command',
        description: 'Local extension command',
        source: 'extension',
      },
      {
        name: 'compact',
        description: 'Summarize the conversation',
        source: 'builtin',
      },
    ],
    models: [
      {provider: 'fixture', id: 'small', name: 'Fixture small'},
      {provider: 'fixture-other', id: 'large', name: 'Fixture large'},
    ],
    model: {provider: 'fixture', id: 'small'},
    thinkingLevel: 'medium',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    speedMode: 'regular',
    speedModes: ['regular'],
    tools: [{name: 'bash', description: 'Run a local command'}],
    diagnostics: [],
    ...(agentProfile ? {agentProfile} : {}),
  };
}

function applyFixtureSpeed(key, target, command) {
  const match = /^\/(fast|ultrafast) (on|off)$/.exec(command);
  if (!match) return false;
  if (dialogErrors.get('speed')) throw new Error(dialogErrors.get('speed'));
  const mode = match[2] === 'off' ? 'regular' : match[1];
  const resource = resources.get(key) || features();
  assert.ok(resource.speedModes.includes(mode));
  target.speedMode = mode;
  resource.speedMode = mode;
  resources.set(key, resource);
  window.webContents.send('fixture:snapshot', hub);
  return true;
}

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Keep animation frames running across reloads when another window covers the fixture.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function session(id, name) {
  return {
    session: {
      id,
      name,
      cwd: directory,
      model: 'fixture/small',
      thinkingLevel: 'medium',
      status: 'running',
      activity: 'Running bash: checking the project',
      startedAt: at,
      updatedAt: at,
      owned: true,
      controllable: true,
    },
    agents: [],
    totalAgents: 0,
    events: [],
    changes: [],
    conversationTruncated: false,
    queue: {steering: [], followUp: []},
    conversation: [
      {id: `${id}-user`, role: 'user', text: 'Inspect the project', at},
      {
        id: `${id}-assistant`,
        role: 'assistant',
        text: 'I will inspect the project.',
        at,
      },
      {
        id: `${id}-tool`,
        role: 'tool',
        toolName: 'bash',
        toolCallId: `${id}-call`,
        input: 'printf "first line\\nsecond line\\n"',
        status: 'running',
        streaming: true,
        text: 'first line\n',
        at,
      },
    ],
  };
}

const agentScopes = ['builtin', 'global', 'repository', 'workspace'];

function agentSourcePath(scope, id) {
  if (scope === 'builtin') return `/fixture/builtin/agents/${id}.md`;
  if (scope === 'global') return `/fixture/settings/agents/${id}.md`;
  if (scope === 'workspace')
    return `/fixture/settings/workspaces/project/agents/${id}.md`;
  return join(directory, '.varisdev', 'agents', `${id}.md`);
}

function agentDefinition(scope, id, fields) {
  return {
    id,
    key: `${scope}:${id}`,
    instructions: '',
    ...fields,
    scope,
    sourcePath: fields.sourcePath || agentSourcePath(scope, id),
  };
}

function initialAgentTemplates() {
  return [
    agentDefinition('builtin', 'default', {
      name: 'Default',
      instructions: '',
      mode: 'all',
      context: 'workspace',
    }),
    agentDefinition('builtin', 'build', {
      name: 'Build',
      description: 'Coding agent with broad tool access.',
      instructions: '',
      mode: 'primary',
      context: 'workspace',
    }),
    agentDefinition('builtin', 'plan', {
      name: 'Plan',
      description: 'Planning agent without normal project edits.',
      instructions: '',
      mode: 'primary',
      context: 'workspace',
    }),
    agentDefinition('builtin', 'general', {
      name: 'General',
      description: 'General-purpose delegated agent.',
      instructions: '',
      mode: 'subagent',
      context: 'task',
    }),
    agentDefinition('builtin', 'explore', {
      name: 'Explore',
      description: 'Read-only discovery agent.',
      instructions: '',
      mode: 'subagent',
      context: 'task',
    }),
  ];
}

function authoredAgentTemplates() {
  return [
    agentDefinition('global', 'writer', {
      name: 'Writer',
      instructions: 'Implement requested changes.',
      mode: 'primary',
      context: 'workspace',
      color: '#74F3C0',
    }),
    agentDefinition('global', 'researcher', {
      name: 'Researcher',
      description: 'Researches delegated questions.',
      instructions: 'Research the delegated task.',
      mode: 'subagent',
      context: 'task',
    }),
    agentDefinition('repository', 'flex', {
      name: 'Flexible agent',
      instructions: 'Handle primary or delegated work.',
      mode: 'all',
      context: 'workspace',
    }),
    agentDefinition('global', 'hidden-helper', {
      name: 'Hidden helper',
      instructions: 'Perform hidden maintenance.',
      mode: 'all',
      hidden: true,
    }),
    agentDefinition('global', 'disabled-helper', {
      name: 'Disabled helper',
      instructions: 'This agent is disabled.',
      mode: 'primary',
      disabled: true,
    }),
    agentDefinition('global', 'team/reviewer', {
      name: 'Team reviewer',
      description: 'Reviews changes for regressions.',
      instructions: 'Review changes and report concrete findings.',
      mode: 'all',
      context: 'workspace',
      color: '#FF6B6B',
      permissions: [{action: 'edit', resource: '*', effect: 'deny'}],
    }),
    agentDefinition('repository', 'team/reviewer', {
      context: 'task',
      permissions: [{action: 'read', resource: 'src/**', effect: 'allow'}],
    }),
    agentDefinition('repository', 'team/reviewer', {
      description: 'Applies package review rules.',
      request: {
        headers: {'x-fixture-scope': 'package'},
        body: {temperature: 0.2, metadata: {source: 'fixture'}},
      },
      permissions: [
        {action: 'read', resource: 'packages/app/**', effect: 'allow'},
      ],
      sourcePath: join(
        directory,
        'packages',
        'app',
        '.varisdev',
        'agents',
        'team',
        'reviewer.md',
      ),
    }),
    agentDefinition('workspace', 'team/reviewer', {
      steps: 6,
    }),
  ];
}

function agentDefinitionDirectory(definition) {
  return definition.sourcePath
    .slice(0, -`${definition.id}.md`.length)
    .replace(/[\\/]$/, '');
}

function mergeAgentDefinitions(id, definitions) {
  const selected = definitions.at(-1);
  const effective = {
    id,
    key: selected.key,
    name: id,
    instructions: '',
    mode: 'primary',
    context: 'workspace',
    hidden: false,
    disabled: false,
    permissions: [],
    scope: selected.scope,
    sourcePath: selected.sourcePath,
  };
  let hasInstructions = false;
  for (const definition of definitions) {
    for (const field of [
      'name',
      'description',
      'mode',
      'context',
      'model',
      'thinkingLevel',
      'hidden',
      'disabled',
      'color',
      'steps',
      'request',
    ])
      if (definition[field] !== undefined) effective[field] = definition[field];
    if (definition.instructions || !hasInstructions) {
      effective.instructions = definition.instructions;
      hasInstructions = true;
    }
    if (definition.permissions)
      effective.permissions.push(...definition.permissions);
  }
  return effective;
}

function listFixtureAgentTemplates(cwd) {
  const grouped = new Map();
  for (const scope of agentScopes)
    for (const definition of agentTemplates.filter(
      item => item.scope === scope,
    )) {
      const definitions = grouped.get(definition.id) || [];
      definitions.push(definition);
      grouped.set(definition.id, definitions);
    }
  const effective = [...grouped]
    .map(([id, definitions]) => mergeAgentDefinitions(id, definitions))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    templates: effective.filter(template => !template.disabled),
    allTemplates: agentTemplates,
    sources: agentScopes.flatMap(scope => {
      const scoped = agentTemplates.filter(
        template => template.scope === scope,
      );
      const directories =
        scope === 'repository'
          ? [
              ...new Set([
                join(cwd, '.varisdev', 'agents'),
                ...scoped.map(agentDefinitionDirectory),
              ]),
            ]
          : [
              scope === 'global'
                ? '/fixture/settings/agents'
                : scope === 'workspace'
                  ? '/fixture/settings/workspaces/project/agents'
                  : '/fixture/builtin/agents',
            ];
      return directories.map(directory => ({
        scope,
        directory,
        templates: scoped.filter(
          template => agentDefinitionDirectory(template) === directory,
        ),
      }));
    }),
    diagnostics: [],
    ...(defaultAgentId ? {defaultAgentId} : {}),
    ...(defaultAgent ? {defaultAgent} : {}),
  };
}

function reset() {
  imageModel = '';
  hub = {
    launchCwd: directory,
    selectedSessionId: 'alpha',
    sessions: [
      session('alpha', 'Alpha factory'),
      session('beta', 'Beta factory'),
    ],
  };
  calls = [];
  rendererErrors = [];
  editorSubmission = undefined;
  chosenFolder = undefined;
  abortDelay = 0;
  cancellationError = undefined;
  creationIds = ['folder-parent'];
  creationDelay = 0;
  creationError = undefined;
  closeDelay = 0;
  closeError = undefined;
  resumeError = undefined;
  agentPromptError = undefined;
  agentPromptDelay = 0;
  dialogDelays = new Map();
  dialogErrors = new Map();
  agentTemplates = initialAgentTemplates();
  defaultAgentId = 'default';
  defaultAgent = undefined;
  templateError = undefined;
  toolSettings = fixtureToolSettings();
  toolSettingsError = undefined;
  archivedSessions = new Map();
  savedSessions = [
    {
      id: 'saved-parent',
      name: 'Saved conversation',
      firstMessage: 'Inspect the project',
      modified: at,
      messageCount: 2,
    },
  ];
  recentProjects = [directory, join(directory, 'other-project')];
  recentProjectsDelay = 0;
  recentProjectsError = undefined;
  workspaceTemplateResponses = new Map();
  workspaceTemplateDelays = new Map();
  workspaceTemplateErrors = new Map();
  resources = new Map([
    ['alpha', features()],
    ['beta', features()],
  ]);
  featureRequests = [];
  featureDelays = new Map();
  featureGates = new Map();
  featureErrors = new Map();
}

ipcMain.handle('fixture:terminal', (_event, action, sessionId, request) => {
  calls.push({method: 'terminal', action, sessionId, request});
  if (action === 'open')
    return {
      generation: 1,
      sequence: 1,
      data: 'Fixture shell ready\r\n$ ',
    };
});
ipcMain.handle('fixture:state', () => hub);
ipcMain.handle('fixture:recent-projects', async () => {
  const folders = [...recentProjects];
  const error = recentProjectsError;
  if (recentProjectsDelay)
    await new Promise(resolve => setTimeout(resolve, recentProjectsDelay));
  if (error) throw new Error(error);
  return folders;
});
ipcMain.on('fixture:error', (_event, error) => rendererErrors.push(error));
for (const method of ['prompt', 'abort', 'workspace', 'cancelAgent']) {
  ipcMain.handle(`fixture:${method}`, async (_event, sessionId, request) => {
    calls.push({method, sessionId, request});
    const target = hub.sessions.find(item => item.session.id === sessionId);
    if (method === 'prompt' && dialogErrors.get('promptSession'))
      throw new Error(dialogErrors.get('promptSession'));
    if (
      method === 'prompt' &&
      applyFixtureSpeed(sessionId, target.session, request.prompt)
    )
      return;
    if (method === 'cancelAgent') {
      if (cancellationError) throw new Error(cancellationError);
      for (const agent of target.agents) {
        if (
          (request === 'all' || request === agent.id) &&
          ['running', 'queued'].includes(agent.status)
        )
          agent.status =
            agent.status === 'running' ? 'cancelling' : 'cancelled';
      }
      window.webContents.send('fixture:snapshot', hub);
    }
    if (method === 'prompt' && request.prompt === '/model') {
      target.ui ||= {dialogs: [], notifications: [], statuses: []};
      target.ui.dialogs = [
        {
          id: 'native-model',
          kind: 'terminal',
          title: 'Model & thinking',
          actions: [
            {id: 'default', label: 'Make as default'},
            {id: 'session', label: 'Apply to session'},
          ],
          terminal: {
            columns: 100,
            rows: 28,
            output:
              '\x1bcModel picker\r\n> \r\nfixture/small\r\nfixture-other/large',
            revision: 1,
          },
        },
      ];
      window.webContents.send('fixture:snapshot', hub);
      return;
    }
    if (
      method === 'prompt' &&
      /^\/(?:compact|reload)(?:\s|$)/.test(request.prompt)
    )
      return;
    if (
      method === 'prompt' &&
      ['/thinking', '/settings'].includes(request.prompt)
    ) {
      target.ui ||= {dialogs: [], notifications: [], statuses: []};
      target.ui.dialogs = [
        request.prompt === '/thinking'
          ? {
              id: 'native-thinking',
              kind: 'select',
              title: 'Thinking level',
              options: resources.get(sessionId).thinkingLevels,
              selected: target.session.thinkingLevel,
              selection: resources
                .get(sessionId)
                .thinkingLevels.indexOf(target.session.thinkingLevel),
              terminal: {
                columns: 100,
                rows: 28,
                output: terminalMenuOutput(
                  'Thinking level',
                  resources.get(sessionId).thinkingLevels,
                  resources
                    .get(sessionId)
                    .thinkingLevels.indexOf(target.session.thinkingLevel),
                ),
                revision: 1,
              },
            }
          : {
              id: 'native-settings',
              kind: 'terminal',
              title: 'Settings',
              options: ['Auto retry: off', 'Transport: auto'],
              selection: 0,
              terminal: {
                columns: 100,
                rows: 28,
                output: terminalMenuOutput(
                  'Settings',
                  ['Auto retry: off', 'Transport: auto'],
                  0,
                ),
                revision: 1,
              },
            },
      ];
      window.webContents.send('fixture:snapshot', hub);
      return;
    }
    if (method === 'prompt' && target.session.status === 'running') {
      target.queue.steering.push(request.prompt);
      window.webContents.send('fixture:snapshot', hub);
    }
    if (method === 'abort') {
      const cleared = structuredClone(target.queue);
      target.queue = {steering: [], followUp: []};
      window.webContents.send('fixture:snapshot', hub);
      if (abortDelay)
        await new Promise(resolve => setTimeout(resolve, abortDelay));
      return cleared;
    }
    return method === 'workspace'
      ? {cwd: directory, files: [], diff: '', truncated: false}
      : undefined;
  });
}

ipcMain.handle('fixture:agent-session', async (_event, sessionId, request) => {
  calls.push({method: 'agentSession', sessionId, request});
  const owner = hub.sessions.find(item => item.session.id === sessionId);
  const agent = owner?.agents.find(item => item.id === request.agentId);
  assert.ok(agent, `Unknown agent ${sessionId}/${request.agentId}`);
  const key = `${sessionId}:${agent.id}`;
  if (request.action === 'features') {
    featureRequests.push(key);
    if (featureDelays.get(key))
      await new Promise(resolve => setTimeout(resolve, featureDelays.get(key)));
    if (featureErrors.get(key)) throw new Error(featureErrors.get(key));
    return structuredClone(resources.get(key) || features());
  }
  if (request.action === 'command') {
    if (applyFixtureSpeed(key, agent, request.command)) return;
    assert.ok(['/model', '/approvals'].includes(request.command));
    owner.ui ||= {dialogs: [], notifications: [], statuses: []};
    owner.ui.dialogs = [
      request.command === '/approvals'
        ? {
            id: `worker-approvals:${agent.id}`,
            kind: 'select',
            title: 'Remembered approvals',
            options: ['This conversation', 'This agent in this workspace'],
            terminal: {
              columns: 100,
              rows: 28,
              output: terminalMenuOutput('Remembered approvals', [
                'This conversation',
                'This agent in this workspace',
              ]),
              revision: 1,
            },
          }
        : {
            id: `worker-model:${agent.id}`,
            kind: 'terminal',
            title: 'Model & thinking',
            actions: [
              {id: 'default', label: 'Make as default'},
              {id: 'session', label: 'Apply to session'},
            ],
            terminal: {
              columns: 100,
              rows: 28,
              output:
                '\u001bcModel picker\r\n> fixture/small\r\n  fixture-other/large',
              revision: 1,
            },
          },
    ];
  }
  if (request.action === 'prompt') {
    if (applyFixtureSpeed(key, agent, request.prompt)) return;
    if (agentPromptDelay)
      await new Promise(resolve => setTimeout(resolve, agentPromptDelay));
    if (agentPromptError) throw new Error(agentPromptError);
    assert.notEqual(
      agent.resumable,
      false,
      'Disposed agent cannot receive prompts',
    );
    agent.queue ||= {steering: [], followUp: []};
    if (['running', 'queued'].includes(agent.status))
      agent.queue.steering.push(request.prompt);
    else {
      agent.status = 'running';
      agent.conversation ||= [];
      agent.conversation.push({
        id: `direct-${agent.conversation.length}`,
        role: 'user',
        text: request.prompt,
        at,
      });
    }
  }
  if (request.action === 'abort') {
    const queue = structuredClone(agent.queue || {steering: [], followUp: []});
    agent.queue = {steering: [], followUp: []};
    agent.status = 'cancelled';
    window.webContents.send('fixture:snapshot', hub);
    if (abortDelay)
      await new Promise(resolve => setTimeout(resolve, abortDelay));
    return queue;
  }
  if (request.action === 'configure') {
    const configuration = request.configuration;
    if (configuration.modelId)
      agent.model = `${configuration.provider}/${configuration.modelId}`;
    if (configuration.thinkingLevel)
      agent.thinkingLevel = configuration.thinkingLevel;
    const resource = resources.get(key) || features();
    if (configuration.modelId)
      resource.model = {
        provider: configuration.provider,
        id: configuration.modelId,
      };
    if (configuration.thinkingLevel)
      resource.thinkingLevel = configuration.thinkingLevel;
    resources.set(key, resource);
  }
  if (request.action === 'close') {
    agent.resumable = false;
    if (['running', 'queued', 'cancelling'].includes(agent.status))
      agent.status = 'cancelled';
  }
  window.webContents.send('fixture:snapshot', hub);
});

ipcMain.handle('fixture:choose-folder', async () => {
  calls.push({method: 'chooseFolder'});
  const folder = chosenFolder;
  const error = dialogErrors.get('chooseFolder');
  if (dialogDelays.get('chooseFolder'))
    await new Promise(resolve =>
      setTimeout(resolve, dialogDelays.get('chooseFolder')),
    );
  if (error) throw new Error(error);
  return folder;
});
ipcMain.handle('fixture:list-sessions', (_event, cwd) => {
  calls.push({method: 'listSessions', cwd});
  return cwd === directory ? savedSessions : [];
});
ipcMain.handle('fixture:open-workspace-configuration', (_event, cwd) => {
  calls.push({method: 'openWorkspaceConfiguration', cwd});
});
ipcMain.handle('fixture:list-agent-templates', async (_event, cwd) => {
  const result = structuredClone(
    workspaceTemplateResponses.get(cwd) || listFixtureAgentTemplates(cwd),
  );
  const error = workspaceTemplateErrors.get(cwd);
  if (workspaceTemplateDelays.get(cwd))
    await new Promise(resolve =>
      setTimeout(resolve, workspaceTemplateDelays.get(cwd)),
    );
  if (error) throw new Error(error);
  return result;
});
ipcMain.handle('fixture:tool-models', async () => {
  const {OPENAI_IMAGE_PRESETS, DEFAULT_IMAGE_MODEL} = await import(
    pathToFileURL(resolve('src/tools/model-selection.ts')).href
  );
  return [
    {
      id: 'openai-image',
      label: 'OpenAI images',
      model: imageModel,
      presets: OPENAI_IMAGE_PRESETS,
      defaultModel: DEFAULT_IMAGE_MODEL,
    },
  ];
});
ipcMain.handle('fixture:save-tool-model', (_event, tool, model) => {
  calls.push({method: 'saveToolModel', tool, model});
  imageModel = model;
});
ipcMain.handle('fixture:tool-settings', (_event, sessionId) => {
  calls.push({method: 'getToolSettings', sessionId});
  if (toolSettingsError) throw new Error(toolSettingsError);
  return structuredClone(toolSettings);
});
ipcMain.handle('fixture:save-agent-template', (_event, cwd, input) => {
  calls.push({method: 'saveAgentTemplate', cwd, input});
  if (templateError) throw new Error(templateError);
  const template = agentDefinition(input.scope, input.id, input);
  const existingIndex = agentTemplates.findIndex(
    item =>
      item.scope === template.scope && item.sourcePath === template.sourcePath,
  );
  if (existingIndex < 0) agentTemplates.push(template);
  else agentTemplates.splice(existingIndex, 1, template);
  return template;
});
ipcMain.handle('fixture:delete-agent-template', (_event, cwd, input) => {
  calls.push({method: 'deleteAgentTemplate', cwd, input});
  if (templateError) throw new Error(templateError);
  const sourcePath = input.sourcePath || agentSourcePath(input.scope, input.id);
  agentTemplates = agentTemplates.filter(
    item => item.scope !== input.scope || item.sourcePath !== sourcePath,
  );
});
ipcMain.handle('fixture:create-session', async (_event, input) => {
  calls.push({method: 'createSession', input});
  if (creationDelay)
    await new Promise(resolve => setTimeout(resolve, creationDelay));
  if (input.sessionId && resumeError) throw new Error(resumeError);
  if (!input.sessionId && creationError) throw new Error(creationError);
  const parent = input.sessionId
    ? structuredClone(
        archivedSessions.get(input.sessionId) ||
          session(input.sessionId, 'Saved conversation'),
      )
    : session(
        creationIds.shift() || 'folder-parent',
        input.name || 'Selected folder',
      );
  parent.session.cwd = input.cwd;
  parent.session.status = 'idle';
  parent.session.activity = 'Ready';
  if (!input.sessionId) parent.conversation = [];
  hub.sessions.push(parent);
  const listing = listFixtureAgentTemplates(input.cwd);
  const selectedProfile =
    input.templateId === listing.defaultAgentId && listing.defaultAgent
      ? listing.defaultAgent
      : input.templateId
        ? listing.templates.find(
            profile =>
              profile.id === input.templateId ||
              profile.key === input.templateId,
          )
        : undefined;
  resources.set(
    parent.session.id,
    features(
      selectedProfile
        ? {
            id: selectedProfile.id,
            name: selectedProfile.name,
            mode: selectedProfile.mode,
            ...(selectedProfile.color ? {color: selectedProfile.color} : {}),
          }
        : undefined,
    ),
  );
  window.webContents.send('fixture:snapshot', hub);
  return {id: parent.session.id};
});

ipcMain.handle('fixture:close-session', async (_event, sessionId) => {
  calls.push({method: 'closeSession', sessionId});
  if (closeDelay) await new Promise(resolve => setTimeout(resolve, closeDelay));
  if (closeError) throw new Error(closeError);
  const index = hub.sessions.findIndex(item => item.session.id === sessionId);
  assert.notEqual(index, -1, `Unknown session ${sessionId}`);
  const [parent] = hub.sessions.splice(index, 1);
  archivedSessions.set(sessionId, structuredClone(parent));
  if (!savedSessions.some(item => item.id === sessionId))
    savedSessions.unshift({
      id: sessionId,
      name: parent.session.name,
      firstMessage:
        parent.conversation.find(item => item.role === 'user')?.text || '',
      modified: parent.session.updatedAt,
      messageCount: parent.conversation.length,
    });
  resources.delete(sessionId);
  if (hub.selectedSessionId === sessionId)
    hub.selectedSessionId = hub.sessions[0]?.session.id;
  window.webContents.send('fixture:snapshot', hub);
});

ipcMain.handle('fixture:open-file', (_event, sessionId, path) => {
  calls.push({method: 'openFile', sessionId, path});
});
ipcMain.handle('fixture:open-external', (_event, url) => {
  calls.push({method: 'openExternal', url});
  if (url === 'https://example.com/failure')
    throw new Error('Browser unavailable');
});

ipcMain.handle('fixture:read-markdown', (_event, sessionId, path) => {
  assert.ok(hub.sessions.some(item => item.session.id === sessionId));
  return {
    path,
    content: '# Agent tasks\n- [x] Read project files\n- [ ] Finish UI\n',
    version: 'fixture-v1',
    truncated: false,
  };
});

ipcMain.handle('fixture:features', async (_event, sessionId) => {
  assert.ok(resources.has(sessionId), `Unknown feature session ${sessionId}`);
  featureRequests.push(sessionId);
  const result = JSON.parse(JSON.stringify(resources.get(sessionId)));
  const failure = featureErrors.get(sessionId);
  const delay = featureDelays.get(sessionId);
  const gate = featureGates.get(sessionId);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (gate) await gate;
  if (failure) throw new Error(failure);
  return result;
});
for (const method of ['compact', 'reload']) {
  ipcMain.handle(`fixture:${method}`, (_event, sessionId, instructions) => {
    calls.push({method: `${method}Session`, sessionId, instructions});
  });
}
ipcMain.handle('fixture:dialog', async (_event, sessionId, dialogId, value) => {
  calls.push({method: 'respondToDialog', sessionId, dialogId, value});
  const target = hub.sessions.find(item => item.session.id === sessionId);
  const dialog = target.ui.dialogs.find(item => item.id === dialogId);
  const delay = dialogDelays.get(sessionId);
  const failure = dialogErrors.get(sessionId);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (failure) throw new Error(failure);
  const terminalInput =
    value && typeof value === 'object' && typeof value.input === 'string'
      ? value.input
      : undefined;
  if (
    dialog?.terminal &&
    value &&
    typeof value === 'object' &&
    Number.isInteger(value.columns) &&
    Number.isInteger(value.rows)
  ) {
    dialog.terminal.columns = value.columns;
    dialog.terminal.rows = value.rows;
    dialog.terminal.revision++;
  } else if (
    (dialogId === 'native-model' || dialogId.startsWith('worker-model:')) &&
    value &&
    typeof value === 'object' &&
    dialog?.actions.some(action => action.id === value.action)
  ) {
    if (!dialog.keepOpen) target.ui.dialogs = [];
  } else if (dialogId === 'native-thinking' && terminalInput !== undefined) {
    if (
      ['\u001b[B', '\u001bOB', '\u001b[A', '\u001bOA'].includes(terminalInput)
    ) {
      const direction = ['\u001b[B', '\u001bOB'].includes(terminalInput)
        ? 1
        : -1;
      dialog.selection =
        (dialog.selection + direction + dialog.options.length) %
        dialog.options.length;
      dialog.terminal.output = terminalMenuOutput(
        dialog.title,
        dialog.options,
        dialog.selection,
      );
      dialog.terminal.revision++;
    } else if (terminalInput === '\r') {
      const selected = dialog.options[dialog.selection];
      target.session.thinkingLevel = selected;
      resources.get(sessionId).thinkingLevel = selected;
      target.ui.dialogs = [];
    } else if (terminalInput === '\u001b') target.ui.dialogs = [];
  } else if (dialogId === 'native-settings' && terminalInput !== undefined) {
    if (
      ['\u001b[B', '\u001bOB', '\u001b[A', '\u001bOA'].includes(terminalInput)
    ) {
      const direction = ['\u001b[B', '\u001bOB'].includes(terminalInput)
        ? 1
        : -1;
      dialog.selection =
        (dialog.selection + direction + dialog.options.length) %
        dialog.options.length;
      dialog.terminal.output = terminalMenuOutput(
        dialog.title,
        dialog.options,
        dialog.selection,
      );
      dialog.terminal.revision++;
    } else if (terminalInput === '\r') {
      target.ui.dialogs = [
        {
          id: 'native-settings-retry',
          kind: 'terminal',
          title: 'Auto retry',
          options: ['on', 'off'],
          selected: 'off',
          selection: 1,
          terminal: {
            columns: dialog.terminal.columns,
            rows: dialog.terminal.rows,
            output: terminalMenuOutput('Auto retry', ['on', 'off'], 1),
            revision: 1,
          },
        },
      ];
    } else if (terminalInput === '\u001b') target.ui.dialogs = [];
  } else if (
    dialogId === 'native-settings-retry' &&
    terminalInput !== undefined
  ) {
    if (terminalInput === '\u001b') target.ui.dialogs = [];
    else if (terminalInput === '\r') target.ui.dialogs = [];
  } else if (
    dialogId === 'native-thinking' &&
    dialog?.options.includes(value)
  ) {
    target.session.thinkingLevel = value;
    resources.get(sessionId).thinkingLevel = value;
    target.ui.dialogs = [];
  } else if (dialogId === 'native-settings' && value === 'Auto retry: off') {
    target.ui.dialogs = [
      {
        id: 'native-settings-retry',
        kind: 'select',
        title: 'Auto retry',
        options: ['on', 'off'],
        selected: 'off',
      },
    ];
  } else if (
    target.ui.extensionEditor?.id === dialogId &&
    typeof value === 'string'
  ) {
    target.ui.dialogs = [
      {
        id: 'custom-editor-terminal',
        kind: 'terminal',
        title: 'Edit fixture draft',
        terminal: {
          columns: 60,
          rows: 8,
          output:
            '\u001b[36mCustom editor\u001b[0m\r\nEnter submits the fixture draft',
          revision: 1,
        },
      },
    ];
  } else if (
    dialogId === 'custom-editor-terminal' &&
    terminalInput === '\r' &&
    editorSubmission !== undefined
  ) {
    target.ui.dialogs = [];
    target.ui.editor = {id: 'submitted-editor-draft', text: editorSubmission};
  } else if (
    dialog?.terminal &&
    dialog.kind !== 'terminal' &&
    terminalInput !== undefined
  ) {
    if (terminalInput === '\u001b' || terminalInput === '\r')
      target.ui.dialogs = [];
    else if (
      dialog.kind === 'select' &&
      ['\u001b[B', '\u001bOB', '\u001b[A', '\u001bOA'].includes(terminalInput)
    ) {
      const direction = ['\u001b[B', '\u001bOB'].includes(terminalInput)
        ? 1
        : -1;
      dialog.selection =
        ((dialog.selection || 0) + direction + dialog.options.length) %
        dialog.options.length;
      dialog.terminal.output = terminalMenuOutput(
        dialog.title,
        dialog.options,
        dialog.selection,
      );
      dialog.terminal.revision++;
    } else {
      dialog.inputBuffer = `${dialog.inputBuffer || ''}${terminalInput}`;
      dialog.terminal.output += terminalInput;
      dialog.terminal.revision++;
    }
  } else if (dialog?.terminal && terminalInput !== undefined) {
    dialog.terminal.output += `\r\nReceived ${JSON.stringify(terminalInput)}`;
    dialog.terminal.revision++;
  } else {
    target.ui.dialogs = target.ui.dialogs.filter(item => item.id !== dialogId);
  }
  window.webContents.send('fixture:snapshot', hub);
});

async function press(keyCode, modifiers = []) {
  await focusRenderer();
  window.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
  window.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
  await settle();
}

class UIOperationTimeout extends Error {}
let operationFailure;

async function uiOperation(name, action) {
  if (operationFailure) throw operationFailure;
  report.operation = name;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const origin = new Error().stack;
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          operationFailure = new UIOperationTimeout(
            `${name} timed out in ${report.activeCase}\n` +
              JSON.stringify({
                bounds: window.getBounds(),
                zoom: window.webContents.getZoomFactor(),
                visible: window.isVisible(),
                focused: window.isFocused(),
              }) +
              `\n${origin}`,
          );
          reject(operationFailure);
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!operationFailure) delete report.operation;
  }
}

async function capturePage(rect) {
  return uiOperation(`Capture page ${JSON.stringify(rect || {})}`, () =>
    window.webContents.capturePage(rect),
  );
}

async function evaluate(callback, ...args) {
  const result = await uiOperation(
    `Evaluate ${callback.toString().slice(0, 180)}`,
    () =>
      window.webContents.executeJavaScript(
        `(async () => {
      try {
        return {ok: true, value: await (${callback.toString()})(...${JSON.stringify(args)})};
      } catch (error) {
        return {ok: false, error: error.stack || String(error)};
      }
    })()`,
      ),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function settle() {
  // Minimized Windows fixtures throttle frames even with background throttling off.
  if (window.isMinimized()) window.restore();
  await evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function until(callback, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await evaluate(callback)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function reloadPage() {
  await uiOperation(
    'Reload dashboard',
    () =>
      new Promise(resolve => {
        window.webContents.once('did-finish-load', resolve);
        window.webContents.reload();
      }),
  );
  await until(
    () => document.querySelectorAll('#parents .parent-card').length > 0,
    'Reloaded dashboard did not connect',
  );
  await settle();
}

async function publish() {
  window.webContents.send('fixture:snapshot', hub);
  await settle();
}

async function run(name, callback, width = 1600, height = 1000) {
  if (
    process.env.DESKTOP_UI_CASE_PATTERN &&
    !new RegExp(process.env.DESKTOP_UI_CASE_PATTERN).test(name)
  )
    return;
  report.activeCase = name;
  const caseTimer = setTimeout(() => {
    report.fatal = `UI case timed out after 45 seconds: ${name}. Active operation: ${report.operation || 'scenario callback'}`;
    finishRun();
  }, 45000);
  try {
    if (window.webContents.getURL().startsWith('file:')) {
      // Finish the previous window's recovery writes before resetting its profile.
      await uiOperation('Unload dashboard', () =>
        window.loadURL('about:blank'),
      );
      await uiOperation('Reset dashboard storage', () =>
        window.webContents.session.clearStorageData({
          storages: ['localstorage'],
        }),
      );
    }
    reset();
    window.setContentSize(width, height);
    await uiOperation('Load dashboard', () =>
      window.loadFile(resolve(__dirname, '../../assets/dashboard/index.html')),
    );
    // Reset the file origin's zoom after navigation; about:blank has its own zoom.
    window.webContents.setZoomFactor(1);
    await until(
      () => document.querySelectorAll('#parents .parent-card').length > 0,
      'Dashboard never connected to the isolated preload fixture',
    );
    await settle();
    if (process.env.DESKTOP_UI_THEME) {
      await evaluate(theme => {
        window.fixtureTheme = theme;
        const select = document.getElementById('factory-theme');
        select.value = theme;
        select.dispatchEvent(new Event('change', {bubbles: true}));
      }, process.env.DESKTOP_UI_THEME);
      await settle();
    }
    await callback();
    assert.deepEqual(rendererErrors, [], 'Renderer errors');
    const visibleErrors = await evaluate(() =>
      [...document.querySelectorAll('.form-error, #app-error')]
        .filter(item => !item.hidden && item.getClientRects().length)
        .map(item => item.textContent),
    );
    assert.deepEqual(visibleErrors, [], 'Visible application errors');
    if (process.env.DESKTOP_UI_SCREENSHOT_DIR && name.startsWith('composer'))
      await screenshot(`layout-${width}x${height}`);
    report.cases.push({name});
  } catch (error) {
    const result = {
      name,
      error: error.stack || String(error),
      rendererErrors: [...rendererErrors],
    };
    report.cases.push(result);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    // A timed-out renderer operation is still pending. Stop using that window.
    if (error instanceof UIOperationTimeout) throw error;
    try {
      const dragTrace = await evaluate(() => window.fixtureResizeTrace);
      if (dragTrace)
        result.error += `\nNative drag diagnostics: ${JSON.stringify({trace: dragTrace, nativeEvents: resizeNativeTrace})}`;
      if (name.startsWith('Canvas2D factory fallback')) {
        const fallback = await evaluate(() => ({
          canvas: Object.fromEntries(
            Object.entries(
              document.getElementById('factory-canvas').dataset,
            ).filter(([key]) =>
              [
                'renderer',
                'parentStatus',
                'parentMode',
                'agentStatuses',
                'sceneEvents',
              ].includes(key),
            ),
          ),
          documentHidden: document.hidden,
          visibilityState: document.visibilityState,
          bounds: document
            .getElementById('factory-canvas')
            .getBoundingClientRect()
            .toJSON(),
          focused: document.hasFocus(),
          hiddenCanvasAncestor: Boolean(
            document.getElementById('factory-canvas').closest('[hidden]'),
          ),
          themeErrors: [...document.querySelectorAll('#plugin-theme-errors li')]
            .map(item => item.textContent),
          pixels: window.fixturePixelDiagnostics,
          motion: document
            .getElementById('motion-toggle')
            .getAttribute('aria-pressed'),
          reduced: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches,
          markers: [...document.querySelectorAll('.agent-work-marker')].map(
            marker => ({
              id: marker.dataset.agentId,
              hidden: marker.hidden,
              left: marker.style.left,
              top: marker.style.top,
            }),
          ),
          inspector: document.getElementById('inspector-title').textContent,
          selectedSession: document.querySelector(
            '#parents [aria-pressed="true"]',
          )?.textContent,
        }));
        result.error += `\nFallback dashboard: ${JSON.stringify(fallback)}`;
        await fallbackScreenshot(
          `factory-fallback-failure-${report.cases.length}`,
        );
      } else if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot(`failure-${report.cases.length}`);
    } catch (diagnosticError) {
      result.error += `\nFailure diagnostics: ${diagnosticError.stack || diagnosticError}`;
      if (diagnosticError instanceof UIOperationTimeout) throw diagnosticError;
    }
  } finally {
    clearTimeout(caseTimer);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
  delete report.activeCase;
}

async function screenshot(
  name,
  outputDirectory = process.env.DESKTOP_UI_SCREENSHOT_DIR,
) {
  await settle();
  await new Promise(resolve => setTimeout(resolve, 60));
  const output = resolve(outputDirectory);
  mkdirSync(output, {recursive: true});
  const image = await capturePage();
  const path = join(output, `${name}.png`);
  writeFileSync(path, image.toPNG());
  report.screenshots.push(path);
}

async function focusRenderer() {
  // Window focus alone does not activate an inactive application on macOS.
  app.focus({steal: true});
  window.focus();
  window.webContents.focus();
  await until(
    () => document.hasFocus(),
    'Native input fixture did not receive focus',
  );
}

async function pointerPoint(selector, scroll = false) {
  await focusRenderer();
  return evaluate(
    async (selector, scroll) => {
      const element = document.querySelector(selector);
      if (scroll) element?.scrollIntoView({block: 'nearest'});
      let previous;
      let stable = 0;
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!element?.checkVisibility())
          throw new Error(`Pointer target is hidden: ${selector}`);
        const rect = element.getBoundingClientRect();
        const geometry = JSON.stringify(rect.toJSON());
        stable = geometry === previous ? stable + 1 : 0;
        previous = geometry;
        if (stable < 2) continue;
        const point = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        if (
          rect.top < 0 ||
          rect.left < 0 ||
          rect.right > innerWidth ||
          rect.bottom > innerHeight
        )
          throw new Error(
            `Pointer target is clipped: ${selector}: ${JSON.stringify(rect.toJSON())}`,
          );
        if (!element.contains(document.elementFromPoint(point.x, point.y)))
          throw new Error(`Pointer target is covered: ${selector}`);
        if (document.body.dataset.panelResizing)
          throw new Error(`Previous resize is still active: ${selector}`);
        return {...point, width: rect.width, height: rect.height};
      }
      throw new Error(`Pointer target did not settle: ${selector}`);
    },
    selector,
    scroll,
  );
}

async function mouseGesture(callback) {
  assert.equal(
    resizeMouseIsolated,
    false,
    'Native mouse gestures cannot overlap',
  );
  resizeMouseIsolated = true;
  resizeNativeTrace = [];
  expectedResizeMouse = [];
  try {
    return await callback();
  } finally {
    resizeMouseIsolated = false;
    expectedResizeMouse = [];
  }
}

function sendResizeMouse(type, point, clickCount = 1, modifiers = []) {
  const zoom = window.webContents.getZoomFactor();
  const input = {
    type,
    x: Math.round(point.x * zoom),
    y: Math.round(point.y * zoom),
    button: 'left',
    clickCount,
    modifiers,
  };
  if (resizeMouseIsolated) expectedResizeMouse.push(input);
  window.webContents.sendInputEvent(input);
}

async function resizeMouse(type, point, clickCount = 1, modifiers = []) {
  sendResizeMouse(type, point, clickCount, modifiers);
  await settle();
}

async function clickPointer(selector, {scroll = false, minSize = 0} = {}) {
  await mouseGesture(async () => {
    const point = await pointerPoint(selector, scroll);
    assert.ok(
      point.width >= minSize && point.height >= minSize,
      `Small pointer target: ${selector}`,
    );
    sendResizeMouse('mouseMove', point);
    sendResizeMouse('mouseDown', point);
    sendResizeMouse('mouseUp', point);
    await settle();
  });
}

async function dragResize(selector, dx, dy, cancel = false) {
  return mouseGesture(async () => {
    await evaluate(selector => {
      const handle = document.querySelector(selector);
      const events = [];
      let pointerId;
      const snapshot = event => {
        if (event.type === 'pointerdown') pointerId = event.pointerId;
        const bounds = handle.getBoundingClientRect();
        events.push({
          type: event.type,
          target: event.target.id,
          x: event.clientX,
          y: event.clientY,
          buttons: event.buttons,
          trusted: event.isTrusted,
          captured:
            pointerId !== undefined && handle.hasPointerCapture(pointerId),
          focused: document.hasFocus(),
          resizing: document.body.dataset.panelResizing,
          bounds: bounds.toJSON(),
          value: handle.getAttribute('aria-valuenow'),
        });
      };
      const types = [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'gotpointercapture',
        'lostpointercapture',
      ];
      for (const type of types) document.addEventListener(type, snapshot);
      for (const type of ['focus', 'blur'])
        window.addEventListener(type, snapshot);
      window.fixtureResizeTrace = {selector, events};
      window.fixtureResizeCleanup = () => {
        for (const type of types) document.removeEventListener(type, snapshot);
        for (const type of ['focus', 'blur'])
          window.removeEventListener(type, snapshot);
      };
    }, selector);
    let start;
    let released = false;
    try {
      start = await pointerPoint(selector);
      await resizeMouse('mouseMove', start);
      start = await pointerPoint(selector);
      // Submit one ordered gesture so host focus changes cannot enter between
      // synthetic moves while the test is waiting for animation frames.
      sendResizeMouse('mouseDown', start);
      for (const fraction of [0.25, 0.5, 1])
        sendResizeMouse(
          'mouseMove',
          {
            x: start.x + dx * fraction,
            y: start.y + dy * fraction,
          },
          1,
          ['leftButtonDown'],
        );
      if (cancel) {
        window.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
        window.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
      }
      sendResizeMouse('mouseUp', {x: start.x + dx, y: start.y + dy});
      released = true;
      await settle();
      const trace = await evaluate(() => window.fixtureResizeTrace);
      const down = trace.events.find(event => event.type === 'pointerdown');
      const moves = trace.events.filter(
        event => event.type === 'pointermove' && event.buttons === 1,
      );
      assert.ok(
        down?.captured &&
          moves.length > 0 &&
          moves.every(event => event.captured),
        `Native resize must retain pointer capture: ${JSON.stringify({trace, nativeEvents: resizeNativeTrace})}`,
      );
      assert.ok(
        trace.events.some(event => event.type === 'pointerup'),
        `Native resize must release the pointer: ${JSON.stringify(trace)}`,
      );
    } finally {
      if (start && !released)
        await resizeMouse('mouseUp', {x: start.x + dx, y: start.y + dy});
      await evaluate(() => window.fixtureResizeCleanup());
    }
  });
}

async function resizeKey(selector, key, modifiers = []) {
  await evaluate(
    selector => document.querySelector(selector).focus(),
    selector,
  );
  await press(key, modifiers);
}

async function resetResize(selector) {
  await mouseGesture(async () => {
    const point = await pointerPoint(selector);
    await resizeMouse('mouseMove', point);
    for (const count of [1, 2]) {
      sendResizeMouse('mouseDown', point, count);
      sendResizeMouse('mouseUp', point, count);
    }
    await settle();
  });
}

async function resizeLayout({drawer = false, terminal = false} = {}) {
  return evaluate(
    ({drawer, terminal}) => {
      const rect = selector => {
        const element = document.querySelector(selector);
        if (!element?.checkVisibility()) throw new Error(`Hidden ${selector}`);
        const r = element.getBoundingClientRect();
        if (
          r.width <= 0 ||
          r.height <= 0 ||
          r.left < -1 ||
          r.top < -1 ||
          r.right > innerWidth + 1 ||
          r.bottom > innerHeight + 1
        )
          throw new Error(`Clipped ${selector}: ${JSON.stringify(r.toJSON())}`);
        return r.toJSON();
      };
      for (const element of [
        document.documentElement,
        document.body,
        document.querySelector('main'),
      ])
        if (
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollTop !== 0 ||
          element.scrollLeft !== 0
        )
          throw new Error(`Page overflow: ${element.tagName}`);
      const scene = rect('#scene');
      if (scene.width < 180 || scene.height < 90)
        throw new Error(`Scene too small: ${JSON.stringify(scene)}`);
      const conversation = rect('#panel-conversation');
      if (conversation.height < 60)
        throw new Error(
          `Conversation too small: ${JSON.stringify(conversation)}`,
        );
      rect('#composer-slot');
      const selector = terminal ? '#terminal-sessions' : '#parent-prompt';
      const editor = rect(selector);
      if (editor.height < 40) throw new Error('Composer is too small');
      if (!drawer) {
        const element = document.querySelector(selector);
        if (
          !element.contains(
            document.elementFromPoint(editor.left + 8, editor.top + 8),
          )
        )
          throw new Error(`Composer is covered: ${selector}`);
        const sceneElement = document.getElementById('scene');
        if (
          !sceneElement.contains(
            document.elementFromPoint(
              scene.left + scene.width / 2,
              scene.top + scene.height / 2,
            ),
          )
        )
          throw new Error('Scene is covered');
        const action = terminal ? '#terminal-close' : '#send-prompt';
        const button = document.querySelector(action);
        const r = rect(action);
        if (
          !button.contains(
            document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            ),
          )
        )
          throw new Error(`Composer action is covered: ${action}`);
      }
      return {
        scene,
        conversation,
        editor,
        factory: rect('.factory-column'),
        inspector: rect('#inspector'),
      };
    },
    {drawer, terminal},
  );
}

async function populateResizePanels() {
  const data = hub.sessions[0];
  data.agents = Array.from({length: 12}, (_, index) => ({
    id: `resize-worker-${index}`,
    name: `Resize worker ${index}`,
    task: 'Inspect panel resizing and report findings',
    status: index < 6 ? 'running' : 'completed',
    createdAt: at,
    startedAt: at,
    ...(index >= 6 ? {finishedAt: at} : {}),
  }));
  data.totalAgents = data.agents.length;
  data.conversation = Array.from({length: 20}, (_, index) => ({
    id: `resize-message-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    text: `Panel resizing review ${index}\n${'Keep the editor and live scene accessible.\n'.repeat(3)}`,
    at,
  }));
  await publish();
  await until(
    () =>
      document.querySelectorAll('#active-workers button').length >= 6 &&
      document.querySelectorAll('#history-workers button').length >= 6 &&
      document
        .getElementById('panel-conversation')
        .textContent.includes('Panel resizing review'),
    'Resize scenario did not populate conversation and agents',
  );
}

async function assertResizeMarkers() {
  const markers = await evaluate(() => {
    const scene = document.getElementById('scene').getBoundingClientRect();
    return [...document.querySelectorAll('#scene .agent-work-marker')].map(
      marker => {
        const r = marker.getBoundingClientRect();
        return {
          id: marker.dataset.agentId,
          title: marker.title,
          visible: marker.checkVisibility() && r.width > 0 && r.height > 0,
          inside:
            r.left >= scene.left &&
            r.top >= scene.top &&
            r.right <= scene.right &&
            r.bottom <= scene.bottom,
          rect: r.toJSON(),
        };
      },
    );
  });
  assert.equal(markers.length, 6, 'All six working agents keep a scene marker');
  for (const [index, marker] of markers.entries()) {
    assert.ok(
      marker.visible && marker.inside,
      `Working marker remains visible in the scene: ${JSON.stringify(marker)}`,
    );
    assert.ok(
      marker.title.includes('Resize worker'),
      'Compact markers retain their agent name',
    );
    for (const other of markers.slice(index + 1)) {
      const width =
        Math.min(marker.rect.right, other.rect.right) -
        Math.max(marker.rect.left, other.rect.left);
      const height =
        Math.min(marker.rect.bottom, other.rect.bottom) -
        Math.max(marker.rect.top, other.rect.top);
      assert.ok(
        width <= 0.5 || height <= 0.5,
        `Working markers overlap: ${JSON.stringify({first: marker, second: other})}`,
      );
    }
  }
}

async function resizeValue(handle, target, axis = 'height') {
  return evaluate(
    (handle, target, axis) => {
      const separator = document.querySelector(handle);
      return {
        value: document.querySelector(target).getBoundingClientRect()[axis],
        min: Number(separator.getAttribute('aria-valuemin')),
        max: Number(separator.getAttribute('aria-valuemax')),
        now: Number(separator.getAttribute('aria-valuenow')),
        controls: separator.getAttribute('aria-controls'),
        saved: window.localStorage.getItem('varisdev.panel-sizes.v1'),
      };
    },
    handle,
    target,
    axis,
  );
}

async function resizeThemes(name, options, check = resizeLayout) {
  if (!process.env.DESKTOP_UI_SCREENSHOT_DIR) return;
  const {themes, selected} = await evaluate(() => {
    const select = document.getElementById('factory-theme');
    return {
      themes: [...select.options].map(option => option.value),
      selected: select.value,
    };
  });
  for (const theme of themes) {
    await evaluate(theme => {
      const select = document.getElementById('factory-theme');
      select.value = theme;
      select.dispatchEvent(new Event('change', {bubbles: true}));
    }, theme);
    await settle();
    await check(options);
    await screenshot(`${name}-${theme}`);
  }
  await evaluate(theme => {
    const select = document.getElementById('factory-theme');
    select.value = theme;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }, selected);
  await settle();
}

async function resizeZoom(factor) {
  await evaluate(factor => {
    const control = document.getElementById('app-zoom');
    control.value = String(factor);
    control.dispatchEvent(new Event('change', {bubbles: true}));
  }, factor);
  await settle();
}

const fallbackScreenshotDirectory = resolve(
  process.env.DESKTOP_UI_SCREENSHOT_DIR ||
    'generated-images/factory-fallback-ui',
);

async function fallbackScreenshot(name) {
  await screenshot(name, fallbackScreenshotDirectory);
  const rect = await evaluate(() => {
    const r = document.getElementById('factory-canvas').getBoundingClientRect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
  });
  const zoom = window.webContents.getZoomFactor();
  const clip = Object.fromEntries(
    Object.entries(rect).map(([key, value]) => [key, Math.floor(value * zoom)]),
  );
  const image = await capturePage(clip);
  const path = join(fallbackScreenshotDirectory, `${name}-scene.png`);
  writeFileSync(path, image.toPNG());
  report.screenshots.push(path);
}

async function dashboardTheme(id) {
  await evaluate(id => {
    const select = document.getElementById('factory-theme');
    select.value = id;
    select.dispatchEvent(new Event('change', {bubbles: true}));
    window.fixtureExpectedRenderer =
      id === 'year1998' ? 'year1998' : 'factory-2d';
  }, id);
  await until(
    () =>
      document.getElementById('factory-canvas').dataset.renderer ===
      window.fixtureExpectedRenderer,
    `Dashboard did not display ${id} with WebGL unavailable`,
  );
  await settle();
}

async function withUnavailableWebGL(callback) {
  let identifier;
  try {
    window.webContents.debugger.attach('1.3');
    await uiOperation('Enable fallback page debugger', () =>
      window.webContents.debugger.sendCommand('Page.enable'),
    );
    await emulateReducedMotion(false);
    ({identifier} = await uiOperation('Force WebGL unavailable', () =>
      window.webContents.debugger.sendCommand(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `(() => {
            window.fixtureWebGLRequests = [];
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function(type, options) {
              if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) {
                window.fixtureWebGLRequests.push(type);
                return null;
              }
              return getContext.call(this, type, type === '2d'
                ? {...options, willReadFrequently: true} : options);
            };
          })();`,
        },
      ),
    ));
    await evaluate(() => {
      const select = document.getElementById('factory-theme');
      select.value = 'factory';
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await reloadPage();
    await focusRenderer();
    await until(
      () =>
        document.getElementById('factory-canvas').dataset.renderer ===
        'factory-2d',
      'Unavailable WebGL did not create the animated Canvas2D factory',
    );
    assert.deepEqual(
      await evaluate(() => ({
        attemptedWebGL: window.fixtureWebGLRequests.length > 0,
        canvasVisible: document
          .getElementById('factory-canvas')
          .checkVisibility(),
        labelsVisible: !document.getElementById('scene-labels').hidden,
        fallbackHidden: document.getElementById('fallback').hidden,
        has2D: Boolean(
          document.getElementById('factory-canvas').getContext('2d'),
        ),
      })),
      {
        attemptedWebGL: true,
        canvasVisible: true,
        labelsVisible: true,
        fallbackHidden: true,
        has2D: true,
      },
      'Actual dashboard uses its Canvas2D factory after a failed WebGL request',
    );
    await callback();
  } finally {
    try {
      if (window.webContents.debugger.isAttached()) {
        await uiOperation('Reset reduced motion emulation', () =>
          window.webContents.debugger.sendCommand(
            'Emulation.setEmulatedMedia',
            {features: []},
          ),
        );
        if (identifier)
          await uiOperation('Remove forced WebGL failure', () =>
            window.webContents.debugger.sendCommand(
              'Page.removeScriptToEvaluateOnNewDocument',
              {identifier},
            ),
          );
      }
    } finally {
      if (window.webContents.debugger.isAttached())
        window.webContents.debugger.detach();
    }
  }
}

async function emulateReducedMotion(reduced) {
  await uiOperation(`Emulate reduced motion ${reduced}`, () =>
    window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        {
          name: 'prefers-reduced-motion',
          value: reduced ? 'reduce' : 'no-preference',
        },
      ],
    }),
  );
  await settle();
}

async function fallbackPixels(robotId) {
  return evaluate(robotId => {
    const canvas = document.getElementById('factory-canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Dashboard has no Canvas2D context');
    let x = 0,
      y = 0,
      width = canvas.width,
      height = canvas.height;
    if (robotId) {
      const unit = JSON.parse(canvas.dataset.agentStatuses).find(
        unit => unit.id === robotId,
      );
      if (unit?.status !== 'running')
        throw new Error('Pixel motion check requires an actual running robot');
      const marker = document.querySelector(
        `.agent-work-marker[data-agent-id="${robotId}"]`,
      );
      const bounds = canvas.getBoundingClientRect();
      const scaleX = canvas.width / bounds.width;
      const scaleY = canvas.height / bounds.height;
      // The live anchor is just above the robot; include its face and arms.
      x = Math.max(
        0,
        Math.round(
          ((parseFloat(marker.style.left) / 100) * bounds.width - 24) * scaleX,
        ),
      );
      y = Math.max(
        0,
        Math.round(
          ((parseFloat(marker.style.top) / 100) * bounds.height + 4) * scaleY,
        ),
      );
      width = Math.min(canvas.width - x, Math.round(48 * scaleX));
      height = Math.min(canvas.height - y, Math.round(60 * scaleY));
    }
    const pixels = context.getImageData(x, y, width, height).data;
    let hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 4) {
      hash = Math.imul(hash ^ pixels[i], 16777619);
      hash = Math.imul(hash ^ pixels[i + 1], 16777619);
      hash = Math.imul(hash ^ pixels[i + 2], 16777619);
    }
    return {width, height, hash: hash >>> 0};
  }, robotId);
}

async function assertFallbackMotion(animated, message) {
  await settle();
  const first = await fallbackPixels('fallback-running');
  const firstCanvas = await fallbackPixels();
  assert.ok(first.width >= 24 && first.height >= 30);
  let changed = false;
  for (let sample = 0; sample < 3; sample++) {
    await new Promise(resolve => setTimeout(resolve, 160));
    const next = await fallbackPixels('fallback-running');
    assert.equal(next.width, first.width, 'Canvas width stays stable');
    assert.equal(next.height, first.height, 'Canvas height stays stable');
    changed ||= next.hash !== first.hash;
    if (changed) break;
  }
  if (changed !== animated) {
    const nextCanvas = await fallbackPixels();
    await evaluate(
      diagnostics => {
        window.fixturePixelDiagnostics = diagnostics;
      },
      {
        robotChanged: changed,
        canvasChanged: firstCanvas.hash !== nextCanvas.hash,
        firstCanvas,
        nextCanvas,
      },
    );
  }
  assert.equal(changed, animated, message);
}

async function toggleDashboardMotion() {
  await clickPointer('#app-menu-button');
  await clickPointer('#motion-toggle', {scroll: true});
  await press('Escape');
  await settle();
}

async function selectFallbackRobot() {
  await until(
    () =>
      document.querySelector(
        '.agent-work-marker[data-agent-id="fallback-running"]',
      )?.style.left,
    'Running robot did not receive its live scene anchor',
  );
  await mouseGesture(async () => {
    await focusRenderer();
    const point = await evaluate(() => {
      const marker = document.querySelector(
        '.agent-work-marker[data-agent-id="fallback-running"]',
      );
      if (!marker.checkVisibility()) throw new Error('Robot anchor is hidden');
      const rect = marker.parentElement.getBoundingClientRect();
      const point = {
        x: rect.left + (parseFloat(marker.style.left) / 100) * rect.width,
        y: rect.top + (parseFloat(marker.style.top) / 100) * rect.height,
      };
      if (
        document.elementFromPoint(point.x, point.y) !==
        document.getElementById('factory-canvas')
      )
        throw new Error(`Robot is covered at ${JSON.stringify(point)}`);
      return point;
    });
    sendResizeMouse('mouseMove', point);
    sendResizeMouse('mouseDown', point);
    sendResizeMouse('mouseUp', point);
    await settle();
  });
  await until(
    () =>
      document.getElementById('inspector-title').textContent === 'Tool robot',
    'Native canvas click did not select the running robot',
  );
  assert.deepEqual(
    await evaluate(() => ({
      selectedLabel: document.querySelector(
        '#scene-labels [aria-pressed="true"]',
      )?.textContent,
      selectedCard: document.querySelector(
        '#active-workers [aria-pressed="true"] .worker-card-name',
      )?.textContent,
      conversationVisible: document
        .getElementById('conversation')
        .textContent.includes('Tool robot answer'),
    })),
    {
      selectedLabel: 'Tool robot',
      selectedCard: 'Tool robot',
      conversationVisible: true,
    },
    'Canvas selection reaches dashboard labels, agent card and conversation',
  );
}

function populateFallbackFactory() {
  const data = hub.sessions[0];
  data.session.activity = 'Thinking about the project';
  data.agents = [
    ['running', 'Tool robot', 'Using bash'],
    ['queued', 'Queued robot', 'Waiting for a slot'],
    ['completed', 'Completed robot', 'Finished reading files'],
    ['failed', 'Failed robot', 'Command failed'],
    ['cancelling', 'Cancelling robot', 'Stopping the command'],
    ['cancelled', 'Cancelled robot', 'Stopped'],
  ].map(([status, name, activity]) => ({
    id: `fallback-${status}`,
    name,
    task: 'Inspect the factory fallback',
    activity,
    status,
    model: 'fixture/small',
    createdAt: at,
    startedAt: at,
    ...(!['running', 'queued', 'cancelling'].includes(status)
      ? {finishedAt: at}
      : {}),
    conversation: [
      {id: `${status}-answer`, role: 'assistant', text: `${name} answer`, at},
    ],
  }));
  data.totalAgents = data.agents.length;
}

async function fallbackLayout() {
  return evaluate(() => {
    for (const element of [
      document.documentElement,
      document.body,
      document.querySelector('main'),
    ])
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1 ||
        element.scrollTop !== 0 ||
        element.scrollLeft !== 0
      )
        throw new Error(`Fallback layout scrolls: ${element.tagName}`);
    const rect = id => {
      const element = document.getElementById(id);
      const box = element.getBoundingClientRect();
      if (
        !element.checkVisibility() ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.left < -1 ||
        box.top < -1 ||
        box.right > innerWidth + 1 ||
        box.bottom > innerHeight + 1
      )
        throw new Error(
          `Clipped fallback ${id}: ${JSON.stringify(box.toJSON())}`,
        );
      return box;
    };
    const scene = rect('scene');
    if (scene.width < 180 || scene.height < 180)
      throw new Error(
        `Fallback scene too small: ${JSON.stringify(scene.toJSON())}`,
      );
    for (const id of [
      'factory-panel',
      'factory-canvas',
      'inspector',
      'parent-controls',
      'parent-prompt',
      'send-prompt',
      'app-menu-button',
    ])
      rect(id);
    const agents = document.getElementById('factory-agents-button');
    const info = document.getElementById('factory-info-button');
    if (agents.checkVisibility()) rect('factory-agents-button');
    else {
      rect('active-workers');
      rect('history-workers');
    }
    if (info.checkVisibility()) rect('factory-info-button');
    const point = {
      x: scene.left + scene.width / 2,
      y: scene.top + scene.height / 2,
    };
    if (
      !document
        .getElementById('scene')
        .contains(document.elementFromPoint(point.x, point.y))
    )
      throw new Error('Fallback scene is covered');
    return {scene: scene.toJSON(), drawer: agents.checkVisibility()};
  });
}

async function fallbackTransitionEffect() {
  const agent = hub.sessions[0].agents.find(
    item => item.id === 'fallback-failed',
  );
  agent.status = 'running';
  await publish();
  agent.status = 'failed';
  await publish();
  assert.equal(
    await evaluate(() =>
      document
        .getElementById('factory-canvas')
        .dataset.sceneEvents.includes('fallback-failed:failed'),
    ),
    true,
    'Status transition produces a live scene effect',
  );
}

function rgbChannels(color) {
  return color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
}

function contrast(first, second) {
  const luminance = color => {
    const [r, g, b] = rgbChannels(color).map(channel => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  const [low, high] = [luminance(first), luminance(second)].sort(
    (a, b) => a - b,
  );
  return (high + 0.05) / (low + 0.05);
}

async function main() {
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    // Exercise the requested viewport on laptops with smaller displays too.
    enableLargerThanScreen: true,
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: join(__dirname, 'desktop-ui-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.on('before-mouse-event', (event, input) => {
    if (!resizeMouseIsolated) return;
    const expected = expectedResizeMouse[0];
    const allowed =
      expected &&
      input.type === expected.type &&
      input.x === expected.x &&
      input.y === expected.y;
    resizeNativeTrace.push({input, allowed: Boolean(allowed)});
    if (allowed) expectedResizeMouse.shift();
    else event.preventDefault();
  });
  // Windows pauses animation frames for a hidden window even with background
  // throttling disabled. Native-input helpers focus the fixture before gestures.
  window.showInactive();
  window.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`Renderer exited: ${details.reason}`);
  });
  // This uses only local assets and synthetic state, including a separate profile.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) {
      rendererErrors.push(`Unexpected network request: ${details.url}`);
      callback({cancel: true});
    } else callback({});
  });

  await run(
    'Canvas2D factory fallback animates by default without WebGL and supports native robot selection',
    async () => {
      await withUnavailableWebGL(async () => {
        populateFallbackFactory();
        await publish();
        assert.deepEqual(
          await evaluate(() => ({
            saved: localStorage.getItem('varisdev-factory-motion'),
            motion: document
              .getElementById('motion-toggle')
              .getAttribute('aria-pressed'),
            parentStatus:
              document.getElementById('factory-canvas').dataset.parentStatus,
          })),
          {saved: null, motion: 'true', parentStatus: 'running'},
          'Running factory keeps the default motion setting after WebGL fails',
        );
        await assertFallbackMotion(
          true,
          'Real running robots must change the Canvas2D pixels by default',
        );
        await toggleDashboardMotion();
        await assertFallbackMotion(false, 'Motion off freezes fallback robots');
        const before = await fallbackPixels();
        await selectFallbackRobot();
        assert.notEqual(
          (await fallbackPixels()).hash,
          before.hash,
          'Robot selection visibly updates the still Canvas2D scene',
        );
        await toggleDashboardMotion();
        await assertFallbackMotion(
          true,
          'Selected running robot continues its tool animation',
        );
        await fallbackScreenshot('factory-fallback-running-selected');
      });
    },
  );

  await run(
    'Canvas2D factory fallback saves Motion off across reload and follows reduced motion',
    async () => {
      await withUnavailableWebGL(async () => {
        populateFallbackFactory();
        await publish();
        await toggleDashboardMotion();
        await reloadPage();
        await focusRenderer();
        assert.deepEqual(
          await evaluate(() => ({
            saved: localStorage.getItem('varisdev-factory-motion'),
            motion: document
              .getElementById('motion-toggle')
              .getAttribute('aria-pressed'),
            renderer:
              document.getElementById('factory-canvas').dataset.renderer,
            running:
              document.getElementById('factory-canvas').dataset.parentStatus,
          })),
          {
            saved: 'false',
            motion: 'false',
            renderer: 'factory-2d',
            running: 'running',
          },
          'Saved Motion off reaches the fallback renderer after reload',
        );
        await assertFallbackMotion(
          false,
          'Saved Motion off freezes running Canvas2D robots after reload',
        );
        await fallbackScreenshot('factory-fallback-saved-motion-off');
        await emulateReducedMotion(true);
        await toggleDashboardMotion();
        await reloadPage();
        await focusRenderer();
        assert.deepEqual(
          await evaluate(() => ({
            saved: localStorage.getItem('varisdev-factory-motion'),
            motion: document
              .getElementById('motion-toggle')
              .getAttribute('aria-pressed'),
            reduced: window.matchMedia('(prefers-reduced-motion: reduce)')
              .matches,
            title: document.getElementById('motion-toggle').title,
          })),
          {
            saved: 'true',
            motion: 'false',
            reduced: true,
            title: 'Reduced motion is enabled in system settings',
          },
          'System reduced motion applies to a saved Motion on after reload',
        );
        await assertFallbackMotion(
          false,
          'Reduced motion keeps running fallback robots still',
        );
        await emulateReducedMotion(false);
        await until(
          () =>
            document
              .getElementById('motion-toggle')
              .getAttribute('aria-pressed') === 'true',
          'Disabling system reduced motion did not restore saved Motion on',
        );
        await assertFallbackMotion(
          true,
          'Running fallback robots resume when system reduced motion is disabled',
        );
        await emulateReducedMotion(true);
        await until(
          () =>
            document
              .getElementById('motion-toggle')
              .getAttribute('aria-pressed') === 'false',
          'Live system reduced motion change did not pause the fallback',
        );
        await assertFallbackMotion(
          false,
          'Live system reduced motion change freezes the running factory',
        );
        await fallbackScreenshot('factory-fallback-reduced-motion');
      });
    },
  );

  await run(
    'Canvas2D factory fallback renders every shipped theme with statuses selection effects and compact zoom',
    async () => {
      await withUnavailableWebGL(async () => {
        populateFallbackFactory();
        hub.sessions[0].session.status = 'compacting';
        hub.sessions[0].session.activity = 'Compacting conversation';
        await publish();
        await selectFallbackRobot();
        const themes = await evaluate(async () => {
          const {THEMES} = await import('./themes.js');
          const shipped = THEMES.map(theme => theme.id);
          const options = [
            ...document.getElementById('factory-theme').options,
          ].map(option => option.value);
          if (JSON.stringify(shipped) !== JSON.stringify(options))
            throw new Error('Theme review must include every shipped palette');
          return shipped;
        });
        for (const theme of themes) {
          await dashboardTheme(theme);
          for (const [width, height, zoom] of [
            [1600, 1000, 1],
            [1100, 760, 1.5],
          ]) {
            window.setContentSize(width, height);
            await resizeZoom(zoom);
            await evaluate(
              expected => {
                window.fixtureViewport = expected;
              },
              {width: width / zoom, height: height / zoom},
            );
            await until(
              () =>
                Math.abs(innerWidth - window.fixtureViewport.width) < 2 &&
                Math.abs(innerHeight - window.fixtureViewport.height) < 2,
              `Fallback ${theme} viewport did not settle at ${width}/${zoom}`,
            );
            const layout = await fallbackLayout();
            assert.deepEqual(
              await evaluate(() => ({
                parent:
                  document.getElementById('factory-canvas').dataset
                    .parentStatus,
                statuses: JSON.parse(
                  document.getElementById('factory-canvas').dataset
                    .agentStatuses,
                )
                  .map(unit => unit.status)
                  .sort(),
                selected: document.querySelector(
                  '#scene-labels [aria-pressed="true"]',
                )?.textContent,
                processing: document
                  .getElementById('scene')
                  .classList.contains('is-processing'),
              })),
              {
                parent: 'compacting',
                statuses: [
                  'cancelled',
                  'cancelling',
                  'completed',
                  'failed',
                  'queued',
                  'running',
                ],
                selected: 'Tool robot',
                processing: true,
              },
              `${theme}: statuses and robot selection reach the renderer at ${width}/${zoom}`,
            );
            await fallbackTransitionEffect();
            await fallbackScreenshot(
              `factory-fallback-${theme}-${width}x${height}-${zoom}`,
            );
            if (layout.drawer && theme === 'factory') {
              await clickPointer('#factory-agents-button');
              assert.equal(
                await evaluate(() => {
                  const drawer = document.getElementById(
                    'factory-agents-drawer',
                  );
                  const r = drawer.getBoundingClientRect();
                  return (
                    drawer.matches(':popover-open') &&
                    r.left >= 0 &&
                    r.top >= 0 &&
                    r.right <= innerWidth &&
                    r.bottom <= innerHeight &&
                    drawer.querySelectorAll('#active-workers button').length ===
                      3 &&
                    drawer.querySelectorAll('#history-workers button')
                      .length === 3
                  );
                }),
                true,
                'Compact fallback exposes statuses and actions through its agents drawer',
              );
              await fallbackScreenshot(
                'factory-fallback-compact-agents-drawer',
              );
              await press('Escape');
              await clickPointer('#factory-info-button');
              assert.equal(
                await evaluate(() =>
                  document
                    .getElementById('factory-info')
                    .matches(':popover-open'),
                ),
                true,
                'Compact fallback preserves access to session details',
              );
              await fallbackScreenshot('factory-fallback-compact-info');
              await press('Escape');
            }
          }
        }
      });
    },
  );

  await run(
    'panel resizing conversation supports mouse, keyboard, cancellation and saved bounds across reload and zoom',
    async () => {
      await populateResizePanels();
      const value = () =>
        resizeValue('#conversation-resize', '.factory-column', 'width');
      const baseline = await value();
      const normal = await resizeLayout();
      await dragResize('#conversation-resize', -150, 0);
      const widened = await resizeLayout();
      assert.ok(
        widened.inspector.width > normal.inspector.width + 100,
        'Dragging left widens the conversation',
      );
      const committed = await value();
      await resizeMouse('mouseMove', {
        x: widened.factory.right + 80,
        y: widened.factory.top + 80,
      });
      assert.ok(
        Math.abs((await value()).value - committed.value) <= 1,
        'Mouse movement after release must not resize',
      );
      await dragResize('#conversation-resize', 90, 0, true);
      const cancelled = await value();
      assert.ok(
        Math.abs(cancelled.value - committed.value) <= 1,
        'Escape restores the previous width',
      );
      assert.equal(
        cancelled.saved,
        committed.saved,
        'Cancelled drag must not replace the saved width',
      );
      assert.equal(
        await evaluate(() => document.body.dataset.panelResizing || ''),
        '',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-widened-conversation-populated');
      await resizeThemes('panel-resizing-widened-theme');

      await resizeKey('#conversation-resize', 'Home');
      const minimum = await value();
      assert.equal(
        minimum.now,
        minimum.min,
        'Home reaches the minimum factory width',
      );
      await resizeLayout();
      await assertResizeMarkers();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-conversation-max-width');
      await dragResize('#conversation-resize', -100, 0);
      assert.ok(
        Math.abs((await value()).value - minimum.value) <= 1,
        'Dragging cannot pass the minimum width',
      );
      await resizeKey('#conversation-resize', 'Right');
      assert.ok(
        (await value()).value > minimum.value + 10,
        'Right arrow grows the factory column',
      );
      await resizeKey('#conversation-resize', 'Left');
      assert.ok(
        Math.abs((await value()).value - minimum.value) <= 1,
        'Left arrow reverses the width change',
      );
      await resizeKey('#conversation-resize', 'End');
      const maximum = await value();
      assert.equal(
        maximum.now,
        maximum.max,
        'End reaches the maximum factory width',
      );
      assert.ok(maximum.value > minimum.value + 100);
      await resizeLayout();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-conversation-min-width');
      await dragResize('#conversation-resize', 150, 0);
      assert.ok(
        Math.abs((await value()).value - maximum.value) <= 1,
        'Dragging cannot pass the maximum width',
      );
      await resizeKey('#conversation-resize', 'Return');
      assert.ok(
        Math.abs((await value()).value - baseline.value) <= 2,
        'Enter restores the default split',
      );
      assert.equal(JSON.parse((await value()).saved).conversation, undefined);
      await dragResize('#conversation-resize', -100, 0);
      await resetResize('#conversation-resize');
      assert.ok(
        Math.abs((await value()).value - baseline.value) <= 2,
        'Double click restores the default split',
      );

      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      await resizeKey('#conversation-resize', 'Home');
      const narrowMinimum = await value();
      await resizeKey('#conversation-resize', 'End');
      const narrowMaximum = await value();
      assert.ok(
        narrowMaximum.value - narrowMinimum.value > 100,
        'A compact zoomed window must retain useful horizontal resizing',
      );
      await resizeLayout();
      await resizeKey('#conversation-resize', 'Return');
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      await dragResize('#conversation-resize', 120, 0);
      const preferred = await value();
      await reloadPage();
      assert.ok(
        Math.abs((await value()).value - preferred.value) <= 2,
        'Width survives reload',
      );
      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      const compact = await value();
      assert.ok(
        compact.now >= compact.min && compact.now <= compact.max,
        'Compact width stays within its current bounds',
      );
      assert.equal(
        compact.saved,
        preferred.saved,
        'Clamping at a narrow zoomed window must retain the preferred width',
      );
      await resizeLayout();
      await assertResizeMarkers();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-compact-zoom');
      await reloadPage();
      assert.equal(
        (await value()).saved,
        preferred.saved,
        'Compact reload must not overwrite the preferred split',
      );
      await resizeLayout();
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      assert.ok(
        Math.abs((await value()).value - preferred.value) <= 2,
        'Returning to the normal window restores the preferred width',
      );
      await resizeLayout();
    },
  );

  await run(
    'panel resizing workspaces, workers and active history split persists inline and in the agents drawer',
    async () => {
      await populateResizePanels();
      const overview = () => resizeValue('#workspaces-resize', '.overview');
      const workers = () => resizeValue('#agents-resize', '#worker-panels');
      const history = () =>
        resizeValue('#history-resize', '#active-agents-panel', 'width');
      const baselineOverview = await overview();
      await dragResize('#workspaces-resize', 0, 36);
      assert.ok(
        (await overview()).value > baselineOverview.value + 20,
        'Dragging down grows workspaces',
      );
      const baselineWorkers = await workers();
      await dragResize('#agents-resize', 0, -56);
      const grownWorkers = await workers();
      assert.ok(
        grownWorkers.value > baselineWorkers.value + 35,
        `Dragging up grows workers: ${JSON.stringify({baselineWorkers, grownWorkers})}`,
      );
      const baselineHistory = await history();
      await dragResize('#history-resize', 45, 0);
      assert.ok(
        (await history()).value > baselineHistory.value + 25,
        'Dragging right grows active agents',
      );
      await resizeLayout();
      const savedOverview = await overview();
      const savedWorkers = await workers();
      const savedHistory = await history();
      await reloadPage();
      for (const [read, saved] of [
        [overview, savedOverview],
        [workers, savedWorkers],
        [history, savedHistory],
      ])
        assert.ok(
          Math.abs((await read()).value - saved.value) <= 2,
          'Panel dimensions survive reload',
        );

      for (const [selector, read, forward, backward] of [
        ['#workspaces-resize', overview, 'Down', 'Up'],
        ['#agents-resize', workers, 'Up', 'Down'],
        ['#history-resize', history, 'Right', 'Left'],
      ]) {
        await resizeKey(selector, 'Home');
        const minimum = await read();
        assert.equal(
          minimum.now,
          minimum.min,
          `${selector} Home reaches minimum`,
        );
        await resizeKey(selector, forward);
        assert.ok(
          (await read()).value > minimum.value + 8,
          `${selector} arrow grows panel`,
        );
        await resizeKey(selector, backward);
        assert.ok(
          Math.abs((await read()).value - minimum.value) <= 2,
          `${selector} reverse arrow shrinks panel`,
        );
        await resizeKey(selector, 'End');
        const maximum = await read();
        assert.equal(
          maximum.now,
          maximum.max,
          `${selector} End reaches maximum`,
        );
        await resizeLayout();
        await resizeKey(selector, 'Return');
        assert.equal(
          JSON.parse((await read()).saved)[selector.slice(1, -7)],
          undefined,
          `${selector} Enter clears its preference`,
        );
      }
      await dragResize('#workspaces-resize', 0, 28);
      await dragResize('#agents-resize', 0, -40);
      await dragResize('#history-resize', 35, 0);
      const inline = {
        overview: await overview(),
        workers: await workers(),
        history: await history(),
      };
      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      await until(
        () =>
          document.getElementById('factory-agents-button').checkVisibility(),
        'Compact agents drawer control missing',
      );
      await clickPointer('#factory-agents-button');
      await until(
        () =>
          document
            .getElementById('factory-agents-drawer')
            .matches(':popover-open'),
        'Agents drawer did not open',
      );
      const drawerHistory = await history();
      await dragResize('#history-resize', -35, 0);
      const drawerCommitted = await history();
      assert.ok(
        drawerCommitted.value < drawerHistory.value - 20,
        'Active/history split can be dragged in the drawer',
      );
      await dragResize('#history-resize', 30, 0, true);
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('factory-agents-drawer')
            .matches(':popover-open'),
        ),
        true,
        'Escape cancels the drag before closing the drawer',
      );
      assert.ok(
        Math.abs((await history()).value - drawerCommitted.value) <= 1,
        'Escape restores the drawer split',
      );
      assert.equal(
        (await history()).saved,
        drawerCommitted.saved,
        'Cancelled drawer drag retains its preference',
      );
      await resizeKey('#history-resize', 'Home');
      assert.equal((await history()).now, (await history()).min);
      await resizeKey('#history-resize', 'End');
      assert.equal((await history()).now, (await history()).max);
      await resetResize('#history-resize');
      assert.equal(
        JSON.parse((await history()).saved).history,
        undefined,
        'Drawer double click clears the split preference',
      );
      await dragResize('#history-resize', 25, 0);
      const drawerPreference = JSON.parse((await history()).saved);
      assert.equal(
        drawerPreference.workspaces,
        JSON.parse(inline.overview.saved).workspaces,
        'Compact layout retains overview preference',
      );
      assert.equal(
        drawerPreference.agents,
        JSON.parse(inline.workers.saved).agents,
        'Moving workers to drawer retains their height preference',
      );
      await resizeLayout({drawer: true});
      const drawerLists = await evaluate(() =>
        ['active-workers', 'history-workers'].map(id => {
          const list = document.getElementById(id);
          const r = list.getBoundingClientRect();
          const drawer = document
            .getElementById('factory-agents-drawer')
            .getBoundingClientRect();
          return {
            id,
            populated: list.children.length > 0,
            usable:
              r.height >= 90 &&
              r.left >= drawer.left &&
              r.right <= drawer.right &&
              r.bottom <= drawer.bottom,
          };
        }),
      );
      for (const list of drawerLists)
        assert.ok(list.populated && list.usable, JSON.stringify(list));
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-agents-drawer');
      await resizeThemes('panel-resizing-drawer-theme', {drawer: true});
      await press('Escape');
      await resizeLayout();
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      assert.equal(
        await evaluate(() =>
          document
            .getElementById('worker-panels')
            .parentElement.classList.contains('factory-column'),
        ),
        true,
        'Workers return inline at normal size',
      );
      assert.ok(
        Math.abs((await overview()).value - inline.overview.value) <= 2,
        'Overview height restored after compact layout',
      );
      assert.ok(
        Math.abs((await workers()).value - inline.workers.value) <= 2,
        'Workers height restored after compact layout',
      );
      assert.equal(
        JSON.parse((await history()).saved).history,
        drawerPreference.history,
        'Drawer split preference follows workers inline',
      );
      const restored = await history();
      await reloadPage();
      assert.ok(
        Math.abs((await history()).value - restored.value) <= 2,
        'Drawer split survives reload inline',
      );
      await resizeLayout();
      await evaluate(() =>
        document.getElementById('layout-visualization').click(),
      );
      await settle();
      await resizeKey('#workspaces-resize', 'End');
      const withoutScene = await evaluate(() => ({
        column: document.querySelector('.factory-column').clientHeight,
        overview: document
          .getElementById('workspaces-panel')
          .getBoundingClientRect().height,
        workers: document
          .getElementById('worker-panels')
          .getBoundingClientRect().height,
        scene: document.getElementById('factory-panel').hidden,
      }));
      assert.equal(withoutScene.scene, true);
      assert.ok(
        withoutScene.overview > withoutScene.column * 0.75,
        `Hiding the scene releases its resize reservation: ${JSON.stringify(withoutScene)}`,
      );
      assert.ok(
        withoutScene.workers >= 147,
        `Agent lists retain their minimum height: ${JSON.stringify(withoutScene)}`,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-without-visualization');
      await evaluate(() =>
        document.getElementById('layout-visualization').click(),
      );
      await settle();
      await resizeKey('#workspaces-resize', 'Return');
      await resizeLayout();
    },
  );

  await run(
    'panel visibility reclaims space after resizing and restores saved splits',
    async () => {
      await populateResizePanels();
      const dimensions = () =>
        evaluate(() => {
          const rect = id =>
            document.getElementById(id).getBoundingClientRect().toJSON();
          return {
            column: rect('factory-column'),
            workspaces: rect('workspaces-panel'),
            agents: rect('worker-panels'),
            history: rect('active-agents-panel'),
            saved: localStorage.getItem('varisdev.panel-sizes.v1'),
          };
        });
      const toggle = async key => {
        await evaluate(key => {
          document.getElementById(`layout-${key}`).click();
        }, key);
        await settle();
      };
      const assertFilled = async () => {
        const layout = await evaluate(() => {
          const column = document.getElementById('factory-column');
          const rect = column.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            children: [...column.children]
              .filter(child => child.checkVisibility())
              .map(child => ({
                id: child.id,
                ...child.getBoundingClientRect().toJSON(),
              })),
            overflow: [document.documentElement, document.body].some(
              element =>
                element.scrollWidth > element.clientWidth + 1 ||
                element.scrollHeight > element.clientHeight + 1,
            ),
          };
        });
        assert.equal(layout.overflow, false, 'The page must fit the window');
        let bottom = layout.top;
        for (const child of layout.children) {
          assert.ok(
            Math.abs(child.top - bottom) <= 1,
            `Panels must meet without gaps or overlap: ${JSON.stringify(layout)}`,
          );
          assert.ok(child.height > 0, `Visible panel has height: ${child.id}`);
          bottom = child.bottom;
        }
        assert.ok(
          Math.abs(bottom - layout.bottom) <= 1,
          `Panels fill the column: ${JSON.stringify(layout)}`,
        );
      };
      await dragResize('#agents-resize', 0, -60);
      await dragResize('#history-resize', 40, 0);
      const preferred = await dimensions();
      await toggle('visualization');
      const hidden = await dimensions();
      assert.ok(
        hidden.workspaces.height <= preferred.workspaces.height + 1,
        `Hiding the scene must not expand the workspace list into empty space: ${JSON.stringify({preferred, hidden})}`,
      );
      assert.ok(
        hidden.agents.height > preferred.agents.height + 100,
        'Agents and history expand into the space released by the scene',
      );
      await assertFilled();
      await reloadPage();
      assert.equal((await dimensions()).saved, preferred.saved);
      await assertFilled();
      await resizeThemes('panel-visibility-agents-expanded', {}, assertFilled);

      await toggle('workspaces');
      await assertFilled();
      await toggle('agents');
      const conversationOnly = await evaluate(() => ({
        workspace: document.getElementById('factory-workspace').clientWidth,
        conversation: document.getElementById('inspector').clientWidth,
      }));
      assert.ok(
        conversationOnly.workspace - conversationOnly.conversation <= 2,
        'Conversation fills the window when all side panels are hidden',
      );
      await toggle('workspaces');
      await assertFilled();
      await toggle('visualization');
      await assertFilled();
      await toggle('agents');
      await resizeLayout();
      const restored = await dimensions();
      for (const key of ['workspaces', 'agents', 'history'])
        assert.ok(
          Math.abs(restored[key].height - preferred[key].height) <= 2 &&
            Math.abs(restored[key].width - preferred[key].width) <= 2,
          `Showing panels restores the preferred split for ${key}`,
        );
      assert.equal(restored.saved, preferred.saved);

      await dragResize('#workspaces-resize', 0, 36);
      const resized = await dimensions();
      await toggle('visualization');
      await assertFilled();
      await reloadPage();
      await assertFilled();
      assert.equal((await dimensions()).saved, resized.saved);
      await toggle('visualization');
      const shown = await dimensions();
      for (const key of ['workspaces', 'agents'])
        assert.ok(
          Math.abs(shown[key].height - resized[key].height) <= 2,
          `Showing the scene restores the resized ${key} height`,
        );

      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      await resizeLayout();
      await toggle('visualization');
      await assertFilled();
      await reloadPage();
      await assertFilled();
      assert.equal((await dimensions()).saved, resized.saved);
      await resizeThemes(
        'panel-visibility-compact-agents-expanded',
        {},
        assertFilled,
      );
      await toggle('workspaces');
      await assertFilled();
      await toggle('visualization');
      await resizeLayout();
      await evaluate(() => document.getElementById('layout-reset').click());
      await settle();
      await resizeLayout();
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      await assertFilled();
      assert.equal((await dimensions()).saved, resized.saved);
    },
  );

  await run(
    'panel resizing composer grows upward, restores drafts and supports keyboard reset and cancellation',
    async () => {
      await populateResizePanels();
      const value = () => resizeValue('#composer-resize', '#parent-prompt');
      const inlineHeight = () =>
        evaluate(() => document.getElementById('parent-prompt').style.height);
      const savedComposer = () =>
        evaluate(() => ({
          drafts: JSON.parse(
            window.localStorage.getItem('varisdev.composer-drafts.v1') || '[]',
          ),
          heights: JSON.parse(
            window.localStorage.getItem('varisdev.composer-heights.v1') || '[]',
          ),
        }));
      assert.equal(
        await inlineHeight(),
        '',
        'Editor starts with its responsive default height',
      );
      await dragResize('#composer-resize', 0, -40, true);
      assert.equal(
        await inlineHeight(),
        '',
        'Escape restores automatic editor sizing',
      );
      await dragResize('#composer-resize', 0, -45);
      const emptyHeight = await value();
      const emptyInlineHeight = await inlineHeight();
      assert.deepEqual(
        (await savedComposer()).drafts,
        [],
        'An empty resized prompt must not occupy unsent draft recovery',
      );
      assert.equal(
        new Map((await savedComposer()).heights).get('alpha'),
        emptyInlineHeight,
        'Empty prompt height is saved in the separate preference map',
      );
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '',
        'Empty prompt stays empty on reload',
      );
      assert.equal(
        await inlineHeight(),
        emptyInlineHeight,
        'Empty prompt retains its saved height',
      );
      assert.ok(
        Math.abs((await value()).value - emptyHeight.value) <= 2,
        'Empty prompt renders at its saved height after reload',
      );
      assert.deepEqual(
        (await savedComposer()).drafts,
        [],
        'Restoring an empty resized prompt must not create an unsent draft record',
      );
      assert.equal(
        new Map((await savedComposer()).heights).get('alpha'),
        emptyInlineHeight,
      );
      await resizeKey('#composer-resize', 'Return');
      assert.equal(
        await inlineHeight(),
        '',
        'Reset restores automatic sizing for an empty prompt',
      );
      const draft = 'Keep this unsent resizing draft\nwith a second line';
      await evaluate(draft => {
        const editor = document.getElementById('parent-prompt');
        editor.value = draft;
        editor.setSelectionRange(5, 14);
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      }, draft);
      const baseline = await value();
      assert.equal(baseline.controls, 'parent-prompt');
      const before = await resizeLayout();
      await dragResize('#composer-resize', 0, -80);
      const grown = await resizeLayout();
      assert.ok(
        grown.editor.height > before.editor.height + 50,
        `Upward drag grows the message editor: before=${before.editor.height}, after=${grown.editor.height}`,
      );
      assert.ok(
        grown.conversation.height < before.conversation.height - 50,
        `Editor growth takes space from the conversation: before=${before.conversation.height}, after=${grown.conversation.height}`,
      );
      await dragResize('#composer-resize', 0, 40);
      const shrunk = await resizeLayout();
      assert.ok(
        shrunk.editor.height < grown.editor.height - 25,
        `Downward drag shrinks the editor: before=${before.editor.height}, grown=${grown.editor.height}, shrunk=${shrunk.editor.height}`,
      );
      assert.ok(
        shrunk.conversation.height > grown.conversation.height + 25,
        `Downward drag grows the conversation: before=${grown.conversation.height}, after=${shrunk.conversation.height}`,
      );
      const committed = await value();
      await resizeMouse('mouseMove', {
        x: shrunk.editor.left + 20,
        y: shrunk.editor.top + 40,
      });
      assert.ok(
        Math.abs((await value()).value - committed.value) <= 1,
        'Composer stops resizing on release',
      );
      await dragResize('#composer-resize', 0, -48, true);
      assert.ok(
        Math.abs((await value()).value - committed.value) <= 1,
        'Escape restores composer height',
      );
      assert.equal(
        await evaluate(() => document.body.dataset.panelResizing || ''),
        '',
      );
      await resizeKey('#composer-resize', 'Home');
      const minimum = await value();
      assert.ok(
        Math.abs(minimum.value - minimum.min) <= 1,
        'Home reaches editor minimum',
      );
      await resizeKey('#composer-resize', 'Up');
      assert.ok(
        (await value()).value > minimum.value + 10,
        'Up arrow grows editor',
      );
      await resizeKey('#composer-resize', 'Down');
      assert.ok(
        Math.abs((await value()).value - minimum.value) <= 1,
        'Down arrow shrinks editor',
      );
      await resizeKey('#composer-resize', 'End');
      const maximum = await value();
      assert.ok(
        Math.abs(maximum.value - maximum.max) <= 2,
        'End reaches editor maximum',
      );
      const maximumLayout = await resizeLayout();
      assert.ok(
        maximumLayout.conversation.height <= 92,
        'The editor can use available height while retaining the conversation minimum',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-composer-max-height');
      await resizeKey('#composer-resize', 'Return');
      assert.ok(
        Math.abs((await value()).value - baseline.value) <= 2,
        'Enter restores default editor height',
      );
      assert.equal(
        await inlineHeight(),
        '',
        'Enter restores responsive default sizing',
      );
      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      await resizeLayout();
      assert.equal(
        await inlineHeight(),
        '',
        'Temporary compact bounds do not persist a fixed default height',
      );
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      assert.ok(
        Math.abs((await value()).value - baseline.value) <= 2,
        'Reset editor returns to its normal default after shrinking and growing the window',
      );
      await dragResize('#composer-resize', 0, -50);
      await resetResize('#composer-resize');
      assert.ok(
        Math.abs((await value()).value - baseline.value) <= 2,
        'Double click restores default editor height',
      );
      assert.equal(
        await inlineHeight(),
        '',
        'Double click restores responsive default sizing',
      );
      await dragResize('#composer-resize', 0, -65);
      const preferred = await value();
      const preferredInlineHeight = await inlineHeight();
      await reloadPage();
      assert.ok(
        Math.abs((await value()).value - preferred.value) <= 2,
        'Editor height survives reload',
      );
      assert.deepEqual(
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          return {
            draft: editor.value,
            start: editor.selectionStart,
            end: editor.selectionEnd,
          };
        }),
        {draft, start: 5, end: 14},
        'Resizing preserves saved draft and selection',
      );
      await resizeLayout();
      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      await resizeLayout();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-composer-compact-zoom');
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        draft,
      );
      assert.equal(
        await inlineHeight(),
        preferredInlineHeight,
        'Compact bounds retain the manually chosen inline height',
      );
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      await resizeLayout();
      assert.equal(
        await inlineHeight(),
        preferredInlineHeight,
        'Normal window restores the manually chosen inline height',
      );
      assert.ok(
        Math.abs((await value()).value - preferred.value) <= 2,
        'Chosen editor height returns after compact zoom',
      );
      assert.equal(
        calls.some(call => call.method === 'prompt'),
        false,
        'Resizing must not submit the draft',
      );
      await clickPointer('#send-prompt');
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Submitting resized draft did not clear the prompt',
      );
      assert.equal(
        calls.filter(call => call.method === 'prompt').length,
        1,
        'Explicit Send submits the resized draft once',
      );
      assert.equal(
        await inlineHeight(),
        preferredInlineHeight,
        'Submission preserves the chosen editor height',
      );
      assert.deepEqual(
        (await savedComposer()).drafts,
        [],
        'Submitted prompts must release their unsent draft record',
      );
      assert.equal(
        new Map((await savedComposer()).heights).get('alpha'),
        preferredInlineHeight,
        'Submission retains height in the separate preference map',
      );
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '',
        'Submitted draft stays cleared after reload',
      );
      assert.equal(
        await inlineHeight(),
        preferredInlineHeight,
        'Reload retains editor height after submission cleared its text',
      );
      assert.ok(Math.abs((await value()).value - preferred.value) <= 2);
      assert.deepEqual(
        (await savedComposer()).drafts,
        [],
        'Reloading a submitted resized prompt leaves recovery available for unsent text',
      );
      assert.equal(
        new Map((await savedComposer()).heights).get('alpha'),
        preferredInlineHeight,
      );
      await resizeLayout();

      window.setContentSize(1600, 680);
      await settle();
      await resizeKey('#composer-resize', 'Home');
      await dragResize('#composer-resize', 0, (await value()).value - 90);
      assert.equal(
        await inlineHeight(),
        '90px',
        'A short window allows a 90px preference',
      );
      assert.ok(Math.abs((await value()).value - 90) <= 1);
      window.setContentSize(1600, 1000);
      await settle();
      assert.ok(
        Math.abs((await value()).value - 104) <= 1,
        'Normal window displays its minimum height while retaining the 90px preference',
      );
      assert.equal(await inlineHeight(), '90px');
      await dragResize('#composer-resize', 0, -40, true);
      assert.equal(
        await inlineHeight(),
        '90px',
        'Cancelling restores the exact inline preference below the current viewport minimum',
      );
      assert.equal(
        new Map((await savedComposer()).heights).get('alpha'),
        '90px',
        'Cancelled drag preserves the saved 90px preference',
      );
      window.setContentSize(1600, 680);
      await settle();
      assert.ok(
        Math.abs((await value()).value - 90) <= 1,
        'Returning to the short window renders the preserved 90px preference',
      );
      await resizeLayout();
      window.setContentSize(1600, 1000);
      await settle();
      await resizeKey('#composer-resize', 'Return');

      await evaluate(() => {
        window.localStorage.setItem(
          'varisdev.composer-heights.v1',
          JSON.stringify(
            Array.from({length: 200}, (_, index) => [
              `old-height-${index}`,
              '150px',
            ]),
          ),
        );
      });
      await reloadPage();
      assert.equal(
        (await savedComposer()).heights.length,
        200,
        'All 200 old height preferences load',
      );
      assert.deepEqual(
        (await savedComposer()).drafts,
        [],
        'Height preferences do not consume the unsent draft limit',
      );
      const capacityDraft =
        'Recover this new unsent draft while 200 old panel heights exist';
      await evaluate(text => {
        const editor = document.getElementById('parent-prompt');
        editor.value = text;
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      }, capacityDraft);
      await dragResize('#composer-resize', 0, -30);
      const capacityHeight = await inlineHeight();
      const capacityStorage = await savedComposer();
      assert.equal(
        capacityStorage.heights.length,
        200,
        'Adding a preference keeps the height map bounded to 200',
      );
      const heightMap = new Map(capacityStorage.heights);
      assert.equal(
        heightMap.has('old-height-0'),
        false,
        'Adding a preference drops the oldest height',
      );
      assert.equal(
        heightMap.get('old-height-1'),
        '150px',
        'The next oldest height is retained',
      );
      assert.equal(
        heightMap.get('alpha'),
        capacityHeight,
        'The newest height is retained',
      );
      assert.equal(
        capacityStorage.drafts.length,
        1,
        'Only the new unsent text occupies draft recovery',
      );
      assert.equal(
        new Map(capacityStorage.drafts).get('alpha').value,
        capacityDraft,
      );
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        capacityDraft,
        'New unsent text remains recoverable after height map eviction',
      );
      assert.equal(
        await inlineHeight(),
        capacityHeight,
        'New height preference survives reload alongside the unsent draft',
      );
      assert.equal((await savedComposer()).heights.length, 200);
      await resizeLayout();
    },
  );

  await run(
    'panel resizing terminal composer saves height, cancels dragging and retains preference through compact zoom',
    async () => {
      await populateResizePanels();
      const openTerminal = async () => {
        await clickPointer('#terminal-tab');
        await until(
          () =>
            document.querySelector('#terminal-sessions .xterm') &&
            document
              .getElementById('composer-resize')
              .getAttribute('aria-controls') === 'terminal-sessions',
          'Composer separator did not select the terminal',
        );
      };
      const value = () => resizeValue('#composer-resize', '#terminal-sessions');
      const savedHeight = () =>
        evaluate(() =>
          window.localStorage.getItem('varisdev.composer-terminal-height.v1'),
        );
      await openTerminal();
      const baseline = await value();
      const before = await resizeLayout({terminal: true});
      await dragResize('#composer-resize', 0, -70);
      const grown = await resizeLayout({terminal: true});
      assert.ok(
        grown.editor.height > before.editor.height + 45,
        'Upward drag grows terminal',
      );
      assert.ok(grown.conversation.height < before.conversation.height - 45);
      assert.ok(
        Number(await savedHeight()) > baseline.value + 45,
        'Terminal drag saves its height',
      );
      await dragResize('#composer-resize', 0, 35);
      const shrunk = await resizeLayout({terminal: true});
      assert.ok(
        shrunk.conversation.height > grown.conversation.height + 20,
        'Downward terminal drag grows conversation',
      );
      const committed = await value();
      const committedStorage = await savedHeight();
      await resizeMouse('mouseMove', {
        x: shrunk.editor.left + 30,
        y: shrunk.editor.top + 50,
      });
      assert.ok(
        Math.abs((await value()).value - committed.value) <= 1,
        'Terminal stops resizing after release',
      );
      await dragResize('#composer-resize', 0, -45, true);
      assert.ok(
        Math.abs((await value()).value - committed.value) <= 1,
        'Escape restores terminal height',
      );
      assert.equal(
        await savedHeight(),
        committedStorage,
        'Cancelled terminal drag retains saved height',
      );
      await resizeKey('#composer-resize', 'Home');
      const minimum = await value();
      assert.ok(Math.abs(minimum.value - minimum.min) <= 1);
      await resizeKey('#composer-resize', 'Up');
      assert.ok((await value()).value > minimum.value + 10);
      await resizeKey('#composer-resize', 'Down');
      assert.ok(Math.abs((await value()).value - minimum.value) <= 1);
      await resizeKey('#composer-resize', 'End');
      const maximum = await value();
      assert.ok(Math.abs(maximum.value - maximum.max) <= 2);
      await resizeLayout({terminal: true});
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-terminal-max-height');
      await resizeKey('#composer-resize', 'Return');
      assert.equal(
        await savedHeight(),
        null,
        'Enter clears terminal preference',
      );
      assert.ok(Math.abs((await value()).value - baseline.value) <= 2);
      await dragResize('#composer-resize', 0, -45);
      await resetResize('#composer-resize');
      assert.equal(
        await savedHeight(),
        null,
        'Double click clears terminal preference',
      );
      await dragResize('#composer-resize', 0, -65);
      const preferred = await value();
      const preference = await savedHeight();
      await reloadPage();
      await openTerminal();
      assert.ok(
        Math.abs((await value()).value - preferred.value) <= 2,
        'Terminal height survives reload',
      );
      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      const compact = await value();
      assert.ok(
        compact.value <= compact.max + 2 && compact.value >= compact.min - 1,
      );
      assert.equal(
        await savedHeight(),
        preference,
        'Compact clamp retains the terminal height preference',
      );
      await resizeLayout({terminal: true});
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('panel-resizing-terminal-compact-zoom');
      await reloadPage();
      await openTerminal();
      assert.equal(
        await savedHeight(),
        preference,
        'Compact reload retains terminal height preference',
      );
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      assert.ok(
        Math.abs((await value()).value - preferred.value) <= 2,
        'Terminal height returns with normal window size',
      );
      await resizeLayout({terminal: true});
      assert.ok(
        calls.some(
          call =>
            call.method === 'terminal' &&
            call.action === 'resize' &&
            call.request.columns > 0 &&
            call.request.rows > 0,
        ),
        'Resizing integrates with terminal viewport fitting',
      );
    },
  );

  await run(
    'live view shows details and actions when space allows and preserves the scene across resizing',
    async () => {
      const conversationActions = () =>
        calls.filter(
          call =>
            !(
              call.method === 'agentSession' &&
              call.request.action === 'features'
            ),
        );
      const data = hub.sessions[0];
      Object.assign(data.session, {
        name: 'Compact live scene with a long descriptive parent session name',
        cwd: `/fixture/${'long-project-folder/'.repeat(9)}workspace`,
        model: `fixture/${'long-model-identifier-'.repeat(9)}preview`,
        context: {percent: 25, tokens: 32000, window: 128000},
      });
      data.agents = ['running', 'queued', 'completed', 'failed'].map(
        (status, index) => ({
          id: `compact-${index}`,
          name: `Live worker ${index}`,
          status,
          task: 'Inspect compact scene',
          createdAt: at,
          startedAt: at,
          conversation: [
            {id: 'answer', role: 'assistant', at, text: 'Live agent answer'},
          ],
        }),
      );
      data.totalAgents = data.agents.length;
      await publish();
      await evaluate(() => {
        const panel = document.getElementById('factory-panel');
        window.compactLiveView = {
          panel,
          canvas: document.getElementById('factory-canvas'),
          home: panel.parentElement,
          next: panel.nextSibling,
          inside: r =>
            r.top >= 0 &&
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.bottom <= innerHeight,
        };
      });
      const click = async selector => {
        if (/^\.factory-(cane|gun|flamethrower)-holster$/.test(selector)) {
          await click('#app-menu-button');
          await evaluate(() => {
            document.getElementById('app-menu-weapons').open = true;
          });
        }
        await clickPointer(selector, {
          scroll: true,
          minSize: selector === '#factory-info-button' ? 32 : 0,
        });
      };
      const view = focus =>
        evaluate(focus => {
          const $ = id => document.getElementById(id);
          const saved = window.compactLiveView;
          const restored =
            saved.panel.parentElement === saved.home &&
            saved.panel.nextSibling === saved.next;
          if (
            saved.panel.matches(':popover-open') ||
            $('factory-info').matches(':popover-open') ||
            saved.panel !== $('factory-panel') ||
            saved.canvas !== $('factory-canvas') ||
            !restored
          )
            throw new Error('Scene identity, placement, or open state changed');
          if (focus && document.activeElement.id !== focus)
            throw new Error(`Expected focus on ${focus}`);
          for (const item of document.querySelectorAll(
            '.factory-metrics > span',
          )) {
            const r = item.getBoundingClientRect();
            if (r.width && !saved.inside(r))
              throw new Error('Agent metrics outside viewport');
          }
          if ($('factory-workspace').checkVisibility()) {
            const main = document.querySelector('main');
            const panel = saved.panel.getBoundingClientRect();
            const inspector = $('inspector').getBoundingClientRect();
            if (
              !saved.inside(panel) ||
              !saved.inside(inspector) ||
              panel.right > inspector.left ||
              main.scrollHeight > main.clientHeight + 1 ||
              main.scrollWidth > main.clientWidth + 1
            )
              throw new Error(
                'Main panels must fit without page scrolling or overlap',
              );
          }
          const r = $('scene').getBoundingClientRect();
          return {height: r.height};
        }, focus);
      const scenePainted = async () => {
        const rect = await evaluate(() => {
          const r = document.getElementById('scene').getBoundingClientRect();
          return {x: r.x, y: r.y, width: r.width, height: r.height};
        });
        const zoom = window.webContents.getZoomFactor();
        const clip = Object.fromEntries(
          Object.entries(rect).map(([key, value]) => [
            key,
            Math.floor(value * zoom),
          ]),
        );
        await new Promise(resolve => setTimeout(resolve, 150));
        const shown = (await capturePage(clip)).toBitmap();
        let hidden;
        try {
          await evaluate(() => {
            document.getElementById('factory-canvas').style.visibility =
              'hidden';
          });
          await settle();
          // Allow the compositor to submit the hidden-canvas frame before capture.
          await new Promise(resolve => setTimeout(resolve, 60));
          hidden = (await capturePage(clip)).toBitmap();
        } finally {
          await evaluate(() => {
            document.getElementById('factory-canvas').style.visibility = '';
          });
        }
        await settle();
        assert.ok(shown.length > 0, 'Scene capture must contain pixels');
        assert.equal(
          hidden.length,
          shown.length,
          'Scene captures have matching dimensions',
        );
        let changed = 0;
        for (let i = 0; i < shown.length; i += 4)
          if (
            shown[i] !== hidden[i] ||
            shown[i + 1] !== hidden[i + 1] ||
            shown[i + 2] !== hidden[i + 2]
          )
            changed++;
        assert.ok(
          changed > (shown.length / 4) * 0.05,
          `Factory graphics missing at zoom ${zoom}: ${changed} painted pixels`,
        );
      };
      const detailsVisible = collapsed =>
        evaluate(collapsed => {
          const $ = id => document.getElementById(id);
          const info = $('factory-info');
          if (
            $('factory-info-button').checkVisibility() !== collapsed ||
            info.hasAttribute('popover') !== collapsed ||
            info.checkVisibility() === collapsed ||
            $('close-parent-session').checkVisibility() === collapsed
          )
            throw new Error(
              `Expected ${collapsed ? 'collapsed' : 'inline'} details at ${innerWidth}x${innerHeight}; panel ${JSON.stringify($('factory-panel').getBoundingClientRect().toJSON())}`,
            );
          if (!collapsed) {
            for (const id of [
              'factory-model',
              'factory-effort',
              'context-meter',
              'markdown-launcher',
              'close-parent-session',
            ]) {
              const element = $(id);
              const r = element.getBoundingClientRect();
              const panel = $('factory-panel').getBoundingClientRect();
              if (
                !element.checkVisibility() ||
                r.width < 50 ||
                r.left < panel.left ||
                r.right > panel.right ||
                r.bottom > $('scene').getBoundingClientRect().top
              )
                throw new Error(`Inline details clipped: ${id}`);
            }
          }
          if (
            info.textContent.includes($('factory-title').textContent) ||
            info.textContent.includes('/fixture/long-project-folder')
          )
            throw new Error('Session name or folder repeated in details');
        }, collapsed);
      for (const [width, height, zoom, collapsed] of [
        [1600, 1000, 1, false],
        [1100, 760, 1, false],
        [800, 1000, 1, false],
        [1100, 760, 1.25, false],
        [1600, 1000, 2, true],
        [1100, 760, 1.5, true],
      ]) {
        window.setContentSize(width, height);
        await evaluate(zoom => {
          const control = document.getElementById('app-zoom');
          control.value = String(zoom);
          control.dispatchEvent(new Event('change', {bubbles: true}));
        }, zoom);
        await settle();
        assert.equal(window.webContents.getZoomFactor(), zoom);
        const compact = await view();
        await detailsVisible(collapsed);
        await click('.factory-cane-holster');
        assert.equal(
          await evaluate(
            () => document.getElementById('scene').dataset.caneEquipped,
          ),
          'true',
          'Native click equips the cane before switching weapons',
        );
        await click('.factory-gun-holster');
        assert.deepEqual(
          await evaluate(() => {
            const scene = document.getElementById('scene');
            return [scene.dataset.caneEquipped, scene.dataset.gunEquipped];
          }),
          ['false', 'true'],
          'Picking up the gun must holster the cane',
        );
        await click('.factory-cane-holster');
        assert.deepEqual(
          await evaluate(() => {
            const scene = document.getElementById('scene');
            return [scene.dataset.caneEquipped, scene.dataset.gunEquipped];
          }),
          ['true', 'false'],
          'Picking up the cane must holster the gun',
        );
        await click('.factory-cane-holster');
        assert.equal(
          await evaluate(() =>
            document.getElementById('factory-agents-button').checkVisibility(),
          ),
          zoom > 1,
          'Agent lists stay inline when the column has room',
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`live-view-${width}x${height}-${zoom}`);
        assert.ok(
          compact.height >= 180,
          `Compact scene at ${width}/${zoom}: ${compact.height}`,
        );
        await scenePainted();
        if (
          process.env.DESKTOP_UI_SCREENSHOT_DIR &&
          width === 1600 &&
          zoom === 1
        ) {
          const themes = await evaluate(() =>
            [...document.getElementById('factory-theme').options].map(
              option => option.value,
            ),
          );
          for (const theme of themes) {
            await evaluate(theme => {
              const select = document.getElementById('factory-theme');
              select.value = theme;
              select.dispatchEvent(new Event('change'));
            }, theme);
            await screenshot(`live-inline-${theme}`);
          }
          await evaluate(() => {
            const select = document.getElementById('factory-theme');
            select.value = window.fixtureTheme || 'factory';
            select.dispatchEvent(new Event('change'));
            window.compactLiveView.canvas =
              document.getElementById('factory-canvas');
          });
        }
        if (zoom > 1) {
          await click('#factory-agents-button');
          assert.equal(
            await evaluate(() => {
              const drawer = document.getElementById('factory-agents-drawer');
              return (
                drawer.matches(':popover-open') &&
                window.compactLiveView.inside(drawer.getBoundingClientRect()) &&
                [
                  ...drawer.querySelectorAll(
                    '#active-workers, #history-workers',
                  ),
                ].every(
                  list => list.clientHeight >= 90 && list.children.length > 0,
                )
              );
            }),
            true,
            'Drawer must expose usable agent and history lists',
          );
          if (process.env.DESKTOP_UI_SCREENSHOT_DIR && zoom === 1.5) {
            const themes = await evaluate(() =>
              [...document.getElementById('factory-theme').options].map(
                option => option.value,
              ),
            );
            for (const theme of themes) {
              await evaluate(theme => {
                const select = document.getElementById('factory-theme');
                select.value = theme;
                select.dispatchEvent(new Event('change'));
              }, theme);
              await screenshot(`live-drawer-${theme}`);
            }
            await evaluate(() => {
              const select = document.getElementById('factory-theme');
              select.value = window.fixtureTheme || 'factory';
              select.dispatchEvent(new Event('change'));
              window.compactLiveView.canvas =
                document.getElementById('factory-canvas');
            });
          }
          await press('Escape');
          await until(
            () =>
              !document
                .getElementById('factory-agents-drawer')
                .matches(':popover-open'),
            'Escape did not close the agents drawer',
          );
          assert.equal(
            await evaluate(() => document.activeElement.id),
            'factory-agents-button',
          );
          await click('#factory-agents-button');
          await until(
            () =>
              document
                .getElementById('factory-agents-drawer')
                .matches(':popover-open') &&
              document
                .querySelector('#factory-agents-drawer #history-workers button')
                ?.checkVisibility(),
            'Reopening the agents drawer did not expose history',
          );
          await click('#factory-agents-drawer #history-workers button');
          assert.equal(
            await evaluate(
              () =>
                !document
                  .getElementById('factory-agents-drawer')
                  .matches(':popover-open') &&
                document.getElementById('inspector-title').textContent ===
                  'Live worker 2',
            ),
            true,
          );
          await click('#back-to-parent');
        }
        if (collapsed) await click('#factory-info-button');
        const details = await evaluate(collapsed => {
          const $ = id => document.getElementById(id);
          const info = $('factory-info');
          const bounds = info.getBoundingClientRect();
          if (
            info.matches(':popover-open') !== collapsed ||
            !window.compactLiveView.inside(bounds)
          )
            throw new Error(
              `Info outside ${innerWidth}x${innerHeight}: ${JSON.stringify(bounds.toJSON())}`,
            );
          return ['factory-model', 'factory-effort', 'context-meter'].map(
            id => {
              const item = $(id);
              item.scrollIntoView({block: 'nearest'});
              const r = item.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(item);
              const lines = [...range.getClientRects()];
              if (
                r.top < bounds.top ||
                r.bottom > bounds.bottom ||
                (collapsed && item.scrollWidth > item.clientWidth + 1) ||
                parseFloat(getComputedStyle(item).fontSize) < 12 ||
                (collapsed && id === 'factory-model' && lines.length < 2)
              )
                throw new Error(`Unreadable or clipped ${id}`);
              return item.textContent.replace(/(\d)[\s,](?=\d)/g, '$1');
            },
          );
        }, collapsed);
        assert.deepEqual(details, [
          data.session.model,
          'Effort: medium',
          '25% · 32000 / 128000 tokens',
        ]);
        if (collapsed) {
          if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
            await screenshot('live-view-info-small');
          await press('Escape');
          await view('factory-info-button');
        }
        assert.deepEqual(
          conversationActions(),
          [],
          'Viewing details must not affect the running session',
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR && zoom === 1.5)
          await screenshot('compact-live-view-small-150');
      }
      await click('#factory-info-button');
      window.setContentSize(1600, 1200);
      await settle();
      await detailsVisible(false);
      await view('markdown-launcher');
      window.setContentSize(1100, 760);
      await settle();
      await detailsVisible(true);
      await view('factory-info-button');
      data.agents[1].status = 'running';
      data.agents[0].name = 'Updated live worker';
      data.session.activity = 'Thinking about the latest snapshot';
      await publish();
      await until(
        () =>
          document.getElementById('metric-running').textContent === '2' &&
          document.getElementById('metric-queued').textContent === '0' &&
          document
            .getElementById('scene-labels')
            .textContent.includes('Updated live worker'),
        'Scene did not receive live snapshot',
      );
      await view();
      await evaluate(() => {
        [...document.querySelectorAll('#scene-labels button')].find(item =>
          item.textContent.includes('Updated live worker'),
        ).id = 'compact-agent-label';
      });
      await click('#compact-agent-label');
      await view();
      assert.equal(
        await evaluate(
          () => document.getElementById('inspector-title').textContent,
        ),
        'Updated live worker',
      );
      assert.ok(
        await evaluate(() =>
          document
            .getElementById('conversation')
            .textContent.includes('Live agent answer'),
        ),
      );
      await click('#factory-info-button');
      await click('#markdown-launcher');
      await until(
        () => !document.getElementById('markdown-panel').hidden,
        'Markdown launcher did not open files',
      );
      await view();
      await click('#markdown-close');
      await click('#factory-info-button');
      await click('.factory-gun-holster');
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click(),
      );
      await view();
      assert.equal(
        await evaluate(
          () => document.getElementById('scene').dataset.gunEquipped,
        ),
        'false',
        'Switching workspace holsters the gun',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-title').textContent,
        ),
        'Beta factory',
      );
      await click('#factory-info-button');
      hub.sessions = hub.sessions.filter(item => item.session.id !== 'beta');
      await publish();
      await view();
      await detailsVisible(true);
      await click('#factory-info-button');
      await click('#close-parent-session');
      await until(
        () => !document.getElementById('welcome').hidden,
        'Close session action did not remove the session',
      );
      await view();
      assert.deepEqual(conversationActions(), [
        {method: 'closeSession', sessionId: 'alpha'},
      ]);
    },
  );

  await run(
    'streaming leaves history and hidden inspector panels untouched',
    async () => {
      const data = hub.sessions[0];
      const at = data.conversation[0].at;
      data.conversation = Array.from({length: 100}, (_, index) => ({
        id: `history-${index}`,
        role: 'tool',
        toolName: 'read',
        at,
        finishedAt: at,
        status: 'completed',
        input: JSON.stringify({path: `file-${index}.ts`}),
        text: 'saved output\n'.repeat(100),
      }));
      data.conversation.push({
        id: 'live',
        role: 'assistant',
        at,
        text: '0',
        streaming: true,
      });
      data.events = Array.from({length: 160}, (_, index) => ({
        id: `event-${index}`,
        sourceId: 'parent',
        sourceName: 'Parent',
        at,
        kind: 'message',
        message: `Event ${index}`,
        details: {Message: `Event ${index}`},
      }));
      data.changes = [
        {
          id: 'change',
          unitId: 'parent',
          unitName: 'Parent',
          path: 'file.ts',
          tool: 'edit',
          at,
          diff: '+updated',
        },
        {
          id: 'worker-change',
          unitId: 'worker',
          unitName: 'Worker',
          path: 'worker.ts',
          tool: 'write',
          at,
          diff: '+worker output',
        },
      ];
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('changes-count').textContent,
        ),
        '1',
        'The Changes badge updates for the selected agent before opening the tab',
      );
      await evaluate(() => {
        window.performanceMutations = {history: 0, hidden: 0};
        const history = new window.MutationObserver(records => {
          window.performanceMutations.history += records.length;
        });
        for (const row of [
          ...document.querySelectorAll('#conversation > li'),
        ].slice(0, -1))
          history.observe(row, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
        const hidden = new window.MutationObserver(records => {
          window.performanceMutations.hidden += records.length;
        });
        for (const id of [
          'live-feed',
          'unit-changes',
          'unit-facts',
          'usage-calls',
        ])
          hidden.observe(document.getElementById(id), {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
        window.performanceObservers = [history, hidden];
      });
      for (let index = 1; index <= 40; index++) {
        data.conversation.at(-1).text = `Latest ${index}`;
        window.webContents.send('fixture:snapshot', hub);
      }
      await until(
        () =>
          document.querySelector(
            '#conversation > li:last-child .conversation-text',
          ).textContent === 'Latest 40',
        'Latest streaming state was not rendered',
      );
      await settle();
      assert.deepEqual(
        await evaluate(() => {
          for (const observer of window.performanceObservers)
            observer.disconnect();
          return window.performanceMutations;
        }),
        {history: 0, hidden: 0},
      );
      const dragTop = await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop = panel.scrollHeight;
        panel.dispatchEvent(new Event('scroll'));
        panel.dispatchEvent(
          new window.PointerEvent('pointerdown', {bubbles: true}),
        );
        return panel.scrollTop;
      });
      data.conversation.at(-1).text =
        'Output arriving during selection\n'.repeat(80);
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('panel-conversation').scrollTop,
        ),
        dragTop,
        'Streaming must leave an in-progress pointer selection in place',
      );
      await evaluate(() =>
        document.dispatchEvent(new window.PointerEvent('pointerup')),
      );
      await settle();
      assert.ok(
        await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          return panel.scrollHeight - panel.clientHeight - panel.scrollTop < 4;
        }),
        'Following resumes when the pointer is released without a text selection',
      );
      data.conversation.at(-1).text = 'Latest 40';
      await publish();
      await evaluate(() => document.getElementById('tab-feed').click());
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#live-feed > li').length,
        ),
        160,
      );
      data.conversation.at(-1).text = 'Arrived while hidden';
      await publish();
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '#conversation > li:last-child .conversation-text',
            ).textContent,
        ),
        'Latest 40',
      );
      await evaluate(() => document.getElementById('tab-conversation').click());
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '#conversation > li:last-child .conversation-text',
            ).textContent,
        ),
        'Arrived while hidden',
      );
      await evaluate(() => document.getElementById('tab-changes').click());
      assert.equal(
        await evaluate(
          () => document.querySelector('#unit-changes .diff').textContent,
        ),
        '+updated',
      );
      await evaluate(() => {
        document.querySelector('#unit-changes details').open = true;
      });
      data.changes[0].diff = '+updated again';
      await publish();
      await until(
        () =>
          document.querySelector('#unit-changes .diff').textContent ===
          '+updated again',
        'The visible Changes tab did not refresh an existing change',
      );
      data.changes.push({
        id: 'live-change',
        unitId: 'parent',
        unitName: 'Parent',
        path: 'new-file.ts',
        tool: 'write',
        at,
        diff: '+created while viewing Changes',
      });
      await publish();
      await until(
        () =>
          document.querySelectorAll('#unit-changes details').length === 2 &&
          document.getElementById('changes-count').textContent === '2',
        'The visible Changes tab did not show a new file change',
      );
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#unit-changes details')[1].open,
        ),
        true,
        'Live updates preserve expanded diffs',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() => {
          document.querySelector('#unit-changes details').open = true;
        });
        await screenshot('changes-live');
        window.setContentSize(960, 720);
        window.webContents.setZoomFactor(1.25);
        await screenshot('changes-live-compact');
      }
    },
  );

  await run(
    'tool command, live output, selection and disclosure survive streaming',
    async () => {
      const initial = await evaluate(() => {
        const tool = document.querySelector(
          '#conversation li.conversation-tool',
        );
        if (!tool) throw new Error('Conversation has no tool row');
        const details = tool.querySelector('details');
        if (!details)
          throw new Error('Tool row has no disclosure for input/output');
        details.open = true;
        const walker = document.createTreeWalker(tool, NodeFilter.SHOW_TEXT);
        let output;
        while (walker.nextNode()) {
          if (walker.currentNode.data === 'first line\n')
            output = walker.currentNode;
        }
        if (!output)
          throw new Error('Tool output is missing its native text node');
        const range = document.createRange();
        range.setStart(output, 0);
        range.setEnd(output, 5);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.fixtureNodes = {
          tool,
          details,
          output,
          input: tool.querySelector('.tool-input').firstChild,
        };
        return {
          text: tool.textContent,
          selected: window.getSelection().toString(),
        };
      });
      assert.match(initial.text, /bash/i);
      assert.match(initial.text, /printf/);
      assert.match(initial.text, /running|working/i);
      assert.equal(initial.selected, 'first');
      for (const chunk of ['second line\n', 'third line\n']) {
        hub.sessions[0].conversation.at(-1).text += chunk;
        await publish();
        const streamed = await evaluate(() => {
          const {tool, details, output, input} = window.fixtureNodes;
          return {
            sameTool:
              document.querySelector('#conversation li.conversation-tool') ===
              tool,
            sameDetails: tool.querySelector('details') === details,
            sameOutput:
              tool.querySelector('.tool-output').firstChild === output,
            sameInput: tool.querySelector('.tool-input').firstChild === input,
            open: details.open,
            selected: window.getSelection().toString(),
            text: output.data,
          };
        });
        assert.equal(streamed.sameTool, true);
        assert.equal(streamed.sameDetails, true);
        assert.equal(streamed.sameOutput, true);
        assert.equal(streamed.sameInput, true);
        assert.equal(streamed.open, true);
        assert.equal(streamed.selected, 'first');
        assert.equal(streamed.text, hub.sessions[0].conversation.at(-1).text);
      }
      await evaluate(() => {
        window.getSelection().removeAllRanges();
        window.fixtureNodes.details.open = false;
      });
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'completed',
        streaming: false,
        finishedAt: at,
      });
      await publish();
      assert.match(
        await evaluate(
          () =>
            document.querySelector('#conversation li.conversation-tool')
              .textContent,
        ),
        /completed/i,
      );
      assert.deepEqual(
        await evaluate(() => ({
          sameDetails:
            document.querySelector(
              '#conversation .conversation-tool details',
            ) === window.fixtureNodes.details,
          open: window.fixtureNodes.details.open,
          status: window.fixtureNodes.tool.dataset.status,
        })),
        {sameDetails: true, open: false, status: 'completed'},
        'Completing a tool must preserve a disclosure the reader closed',
      );
      assert.equal(
        await evaluate(() => {
          const activity = document.getElementById('conversation-activity');
          return !activity.hidden && activity.getAttribute('role') === 'status';
        }),
        true,
        'Session activity must continue after its tool completes',
      );
    },
  );

  await run(
    'ongoing activity returns for later tools and exposes failures and cancellation',
    async () => {
      const activity = () => {
        const item = document.getElementById('conversation-activity');
        return {
          visible: !item.hidden && item.getClientRects().length > 0,
          text: item.textContent,
        };
      };
      assert.equal((await evaluate(activity)).visible, true);
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'failed',
        streaming: false,
        text: 'Command exited with status 2',
        error: 'Permission denied: config.txt',
        finishedAt: at,
      });
      Object.assign(hub.sessions[0].session, {
        status: 'idle',
        activity: 'Command failed',
        error: 'Permission denied: config.txt',
      });
      await publish();
      assert.equal((await evaluate(activity)).visible, false);
      assert.deepEqual(
        await evaluate(() => ({
          parent: document.getElementById('parent-status').textContent,
          inspector: document.getElementById('inspector-status').textContent,
        })),
        {parent: 'Error', inspector: 'Error'},
      );
      const failed = await evaluate(
        () =>
          document.querySelector('#conversation li.conversation-tool')
            .textContent,
      );
      assert.match(failed, /failed/i);
      assert.match(failed, /Command exited with status 2/);
      assert.deepEqual(
        await evaluate(() => {
          const row = document.querySelector(
            '#conversation .conversation-tool',
          );
          const error = row.querySelector('.conversation-error');
          return {
            status: row.dataset.status,
            error: error.textContent,
            visible: !error.hidden && error.getClientRects().length > 0,
          };
        }),
        {
          status: 'failed',
          error: 'Permission denied: config.txt',
          visible: true,
        },
      );
      hub.sessions[0].conversation.push({
        ...hub.sessions[0].conversation.at(-1),
        id: 'second-tool',
        toolCallId: 'second-call',
        status: 'running',
        streaming: true,
        text: 'Retry output',
        error: undefined,
        finishedAt: undefined,
      });
      Object.assign(hub.sessions[0].session, {
        status: 'running',
        activity: 'Retrying bash command',
        error: undefined,
      });
      await publish();
      const retryActivity = await evaluate(activity);
      assert.equal(
        retryActivity.visible,
        true,
        'Activity must return after the first operation',
      );
      assert.match(retryActivity.text, /Retrying bash command/);
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'cancelled',
        streaming: false,
        finishedAt: at,
      });
      hub.sessions[0].session.status = 'idle';
      await publish();
      assert.match(
        await evaluate(
          () =>
            [
              ...document.querySelectorAll(
                '#conversation li.conversation-tool',
              ),
            ].at(-1).textContent,
        ),
        /cancelled/i,
      );
      assert.equal((await evaluate(activity)).visible, false);
    },
  );

  await run(
    'results and errors reflect completed work while resumed conversations show activity',
    async () => {
      const data = hub.sessions[0];
      Object.assign(data.session, {
        status: 'idle',
        activity: 'Error: Provider unavailable',
        error: 'Provider unavailable',
        response: 'Incomplete response',
      });
      data.conversation.push({
        id: 'failed-response',
        role: 'assistant',
        text: 'Incomplete response',
        error: 'Provider unavailable',
        at,
      });
      await publish();
      await evaluate(() => document.getElementById('tab-details').click());
      const details = () => ({
        resultVisible: document
          .getElementById('result-section')
          .checkVisibility(),
        errorVisible: document
          .getElementById('error-section')
          .checkVisibility(),
        result: document.getElementById('unit-result').textContent,
        error: document.getElementById('unit-error').textContent,
        status: document.getElementById('inspector-status').textContent,
      });
      assert.deepEqual(await evaluate(details), {
        resultVisible: false,
        errorVisible: true,
        result: 'Incomplete response',
        error: 'Provider unavailable',
        status: 'Error',
      });
      for (const status of ['running', 'compacting']) {
        Object.assign(data.session, {status, activity: 'Continuing the task'});
        await publish();
        const current = await evaluate(details);
        assert.equal(current.resultVisible, false);
        assert.equal(current.errorVisible, false);
        assert.notEqual(current.status, 'Error');
        assert.deepEqual(
          await evaluate(() => {
            const card = document.querySelector(
              '#parents .parent-card.selected',
            );
            return {
              attention: card.classList.contains('attention'),
              activity: card.querySelector('.parent-card-activity').textContent,
              errorInTitle: card.title.includes('Provider unavailable'),
            };
          }),
          {
            attention: false,
            activity: 'Continuing the task',
            errorInTitle: false,
          },
        );
      }
      Object.assign(data.session, {
        status: 'running',
        activity: 'Thinking',
        error: undefined,
        response: '',
      });
      await publish();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('result-recovery-running-details');
      await evaluate(() => document.getElementById('tab-conversation').click());
      assert.equal(
        await evaluate(() =>
          document.getElementById('conversation-activity').checkVisibility(),
        ),
        true,
      );
      assert.match(
        await evaluate(
          () => document.getElementById('conversation').textContent,
        ),
        /Provider unavailable/,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('result-recovery-running-conversation');

      Object.assign(data.session, {
        status: 'idle',
        activity: 'Ready for a task',
        response: 'Task completed successfully.',
      });
      await publish();
      await evaluate(() => document.getElementById('tab-details').click());
      assert.deepEqual(await evaluate(details), {
        resultVisible: true,
        errorVisible: false,
        result: 'Task completed successfully.',
        error: '—',
        status: 'Ready',
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('result-recovery-completed');
      data.queue.followUp = ['Next task'];
      await publish();
      assert.equal((await evaluate(details)).resultVisible, false);
      data.queue.followUp = [];

      const agent = {
        id: 'resumed-agent',
        name: 'Resumed agent',
        task: 'Continue working',
        cwd: directory,
        model: 'fixture/small',
        createdAt: at,
        status: 'failed',
        activity: 'Failed',
        output: 'Previous result',
        error: 'Previous error',
        conversation: [],
      };
      data.agents = [agent];
      data.totalAgents = 1;
      await publish();
      await evaluate(() =>
        document.querySelector('#history-workers .history-row').click(),
      );
      await evaluate(() => document.getElementById('tab-details').click());
      assert.equal((await evaluate(details)).errorVisible, true);
      for (const status of ['queued', 'running', 'cancelling']) {
        Object.assign(agent, {status, activity: 'Continuing the task'});
        await publish();
        const current = await evaluate(details);
        assert.equal(current.resultVisible, false, status);
        assert.equal(current.errorVisible, false, status);
      }
      Object.assign(agent, {
        status: 'completed',
        activity: 'Completed',
        output: 'New result',
        error: undefined,
      });
      await publish();
      assert.deepEqual(await evaluate(details), {
        resultVisible: true,
        errorVisible: false,
        result: 'New result',
        error: '—',
        status: 'Completed',
      });
    },
  );

  await run('live activity events disclose linked details', async () => {
    hub.sessions[0].changes = [
      {
        id: 'change-1',
        unitId: 'parent',
        unitName: 'Alpha factory',
        path: 'src/example.js',
        tool: 'edit',
        summary: 'Updated the example',
        diff: 'diff --git a/src/example.js b/src/example.js\n+const value = 1;\n',
        at,
      },
    ];
    hub.sessions[0].events = [
      {
        id: 'event-tool-change',
        sourceId: 'parent',
        sourceName: 'Alpha factory',
        kind: 'tool',
        message: 'Ran a command',
        conversationId: 'alpha-tool',
        details: {},
        at,
      },
      {
        id: 'event-change',
        sourceId: 'parent',
        sourceName: 'Alpha factory',
        kind: 'tool',
        message: 'Updated the example: src/example.js',
        details: {
          File: 'src/example.js',
          Tool: 'edit',
          Diff: hub.sessions[0].changes[0].diff,
        },
        at,
      },
    ];
    hub.sessions[0].agents = [
      {
        id: 'worker-1',
        name: 'Fixture worker',
        task: 'Inspect the fixture project',
        cwd: directory,
        status: 'running',
        createdAt: at,
        startedAt: at,
        model: 'fixture/worker',
        activity: 'Reading src/example.js',
        output: 'Found the example value',
        autoCleanup: false,
        taskTruncated: false,
        outputTruncated: false,
      },
    ];
    hub.sessions[0].totalAgents = 1;
    hub.sessions[0].events.push({
      id: 'event-worker',
      sourceId: 'worker-1',
      sourceName: 'Fixture worker',
      kind: 'activity',
      message: 'Worker inspected the file',
      at,
    });
    await publish();
    await evaluate(() => document.getElementById('tab-feed').click());
    await settle();
    const parentDetail = await evaluate(() => {
      const event = document.querySelector('#live-feed .feed-event');
      event.querySelector('summary').click();
      return event.textContent;
    });
    assert.match(parentDetail, /printf "first line/);
    assert.match(parentDetail, /first line/);
    const changeDetail = await evaluate(() => {
      const event = document.querySelectorAll('#live-feed .feed-event')[1];
      event.querySelector('summary').click();
      return event.textContent;
    });
    assert.match(changeDetail, /src\/example\.js/);
    assert.match(changeDetail, /const value = 1/);
    await evaluate(() =>
      [...document.querySelectorAll('#active-workers button')]
        .find(item => item.textContent.includes('Fixture worker'))
        .click(),
    );
    await evaluate(() => document.getElementById('tab-feed').click());
    await settle();
    const workerDetail = await evaluate(() => {
      const event = document.querySelector('#live-feed .feed-event');
      event.querySelector('summary').click();
      return event.textContent;
    });
    assert.match(workerDetail, /Inspect the fixture project/);
    assert.match(workerDetail, /Reading src\/example\.js/);
    assert.match(workerDetail, /Found the example value/);
  });

  await run(
    'agent live feed keeps green working yellow queued and blue completed history',
    async () => {
      const agent = {
        id: 'status-agent',
        name: 'Status agent',
        task: 'Inspect the project',
        activity: 'Completed the inspection',
        model: 'fixture/small',
        status: 'completed',
        createdAt: at,
        startedAt: at,
        finishedAt: at,
      };
      hub.sessions[0].agents = [agent];
      hub.sessions[0].totalAgents = 1;
      hub.sessions[0].events = ['queued', 'running', 'completed'].map(
        (status, index) => ({
          id: `status-event-${index}`,
          sourceId: agent.id,
          sourceName: agent.name,
          kind: 'agent',
          message: `Inspection ${status}`,
          details: {Status: status},
          at,
        }),
      );
      await publish();
      await evaluate(() => {
        document.querySelector('#history-workers button').click();
        document.getElementById('tab-feed').click();
      });
      await settle();
      const feed = () =>
        [...document.querySelectorAll('#live-feed .feed-event')].map(row => {
          const badge = row.querySelector('.status-badge');
          return {
            label: badge.textContent,
            visible: !badge.hidden && badge.getClientRects().length > 0,
            accent: getComputedStyle(row).borderLeftColor,
            color: getComputedStyle(badge).color,
            background: getComputedStyle(badge).backgroundColor,
          };
        });
      const original = await evaluate(feed);
      assert.deepEqual(
        original.map(row => row.label),
        ['Queued', 'Working', 'Completed'],
        'Historical events must expose the recorded status of the agent',
      );
      assert.ok(original.every(row => row.visible));
      assert.equal(new Set(original.map(row => row.accent)).size, 3);
      for (const row of original) {
        assert.equal(row.accent, row.color);
        assert.ok(
          contrast(row.color, row.background) >= 4.5,
          `${row.label} must remain readable`,
        );
      }
      const [queued, working, completed] = original.map(row =>
        rgbChannels(row.accent),
      );
      assert.ok(working[1] > working[0] + 30 && working[1] > working[2] + 30);
      assert.ok(queued[0] > queued[2] + 60 && queued[1] > queued[2] + 60);
      assert.ok(
        completed[2] > completed[1] + 30 && completed[1] > completed[0] + 30,
        'Completed must look blue with a clear difference from green',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() => {
          for (const details of document.querySelectorAll('#live-feed details'))
            details.open = false;
          document.getElementById('panel-feed').scrollTop = 0;
        });
        await screenshot('agent-status-live-feed');
      }
      agent.status = 'failed';
      agent.activity = 'Inspection failed';
      hub.sessions[0].events.push({
        id: 'status-event-failed',
        sourceId: agent.id,
        sourceName: agent.name,
        kind: 'error',
        message: agent.activity,
        details: {Status: agent.status},
        at,
      });
      await publish();
      const updated = await evaluate(feed);
      assert.deepEqual(
        updated.slice(0, 3),
        original,
        'A new agent status must preserve earlier event colors and labels',
      );
      assert.equal(updated[3].label, 'Failed');
      const failed = rgbChannels(updated[3].accent);
      assert.ok(failed[0] > failed[1] + 50 && failed[0] > failed[2] + 50);
    },
  );

  await run(
    'selected agents are clear and readable in cards scene labels and fallback',
    async () => {
      hub.sessions[0].agents = ['running', 'queued', 'completed'].map(
        (status, index) => ({
          id: `selection-agent-${index}`,
          name: ['Working agent', 'Queued agent', 'Completed agent'][index],
          task: 'Inspect the project',
          activity:
            status === 'queued' ? 'Waiting for a slot' : 'Inspecting files',
          model: 'fixture/small',
          status,
          createdAt: at,
          startedAt: at,
          ...(status === 'completed' ? {finishedAt: at} : {}),
        }),
      );
      hub.sessions[0].totalAgents = 3;
      await publish();
      await evaluate(() => document.getElementById('motion-toggle').click());
      await settle();
      const themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      const selected = () => {
        const card = document.querySelector(
          '#active-workers [aria-pressed="true"], #history-workers [aria-pressed="true"]',
        );
        const label = document.querySelector(
          '#scene-labels [aria-pressed="true"]',
        );
        const other = document.querySelector(
          '#active-workers [aria-pressed="false"]',
        );
        const style = item => ({
          color: getComputedStyle(item).color,
          background: getComputedStyle(item).backgroundColor,
        });
        return {
          inspector: document.getElementById('inspector-title').textContent,
          card: {
            ...style(card),
            name: card.querySelector('.worker-card-name, .history-row-name')
              .textContent,
            taskColor: getComputedStyle(
              card.querySelector('.worker-card-task, .history-row-task'),
            ).color,
          },
          label: {
            ...style(label),
            color: getComputedStyle(label.querySelector('.scene-label-name'))
              .color,
            name: label.textContent,
          },
          other: style(other),
          selectedCards: document.querySelectorAll(
            '#active-workers [aria-pressed="true"], #history-workers [aria-pressed="true"]',
          ).length,
          selectedLabels: document.querySelectorAll(
            '#scene-labels [aria-pressed="true"]',
          ).length,
        };
      };
      for (const theme of themes) {
        await evaluate(theme => {
          const select = document.getElementById('factory-theme');
          select.value = theme;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, theme);
        for (const name of [
          'Working agent',
          'Queued agent',
          'Completed agent',
        ]) {
          await evaluate(
            name =>
              [
                ...document.querySelectorAll(
                  '#active-workers button, #history-workers button',
                ),
              ]
                .find(item => item.textContent.includes(name))
                .click(),
            name,
          );
          await settle();
          const result = await evaluate(selected);
          assert.equal(result.inspector, name);
          assert.equal(result.card.name, name);
          assert.equal(result.label.name, name);
          assert.equal(result.selectedCards, 1);
          assert.equal(result.selectedLabels, 1);
          assert.ok(
            contrast(result.card.background, result.other.background) >= 3,
            `${theme}: selection must stand out from the other agents`,
          );
          for (const surface of [result.card, result.label])
            assert.ok(
              contrast(surface.color, surface.background) >= 4.5,
              `${theme}: the selected name must remain readable`,
            );
          assert.ok(
            contrast(result.card.taskColor, result.card.background) >= 4.5,
            `${theme}: the selected task must remain readable`,
          );
        }
      }
      await evaluate(() => {
        const select = document.getElementById('factory-theme');
        select.value = window.fixtureTheme || 'factory';
        select.dispatchEvent(new Event('change', {bubbles: true}));
        [...document.querySelectorAll('#active-workers button')]
          .find(item => item.textContent.includes('Working agent'))
          .click();
      });
      await settle();
      const bounds = await evaluate(() => {
        const rect = document.getElementById('scene').getBoundingClientRect();
        return {
          x: Math.ceil(rect.x),
          y: Math.ceil(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        };
      });
      const before = (await capturePage(bounds)).toBitmap();
      await evaluate(() =>
        [...document.querySelectorAll('#scene-labels button')]
          .find(item => item.textContent === 'Queued agent')
          .click(),
      );
      await settle();
      assert.equal((await evaluate(selected)).inspector, 'Queued agent');
      const after = (await capturePage(bounds)).toBitmap();
      let changed = 0;
      for (let offset = 0; offset < before.length; offset += 4)
        if (
          !before
            .subarray(offset, offset + 4)
            .equals(after.subarray(offset, offset + 4))
        )
          changed++;
      assert.ok(
        changed > 50,
        'Selecting an agent must visibly change the still scene',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() =>
          document.querySelector('#active-workers .selected').scrollIntoView({
            block: 'nearest',
          }),
        );
        await screenshot('selected-queued-agent');
      }

      // Exercise the same selection when canvas graphics are unavailable.
      let identifier;
      try {
        window.webContents.debugger.attach('1.3');
        await uiOperation('Enable page debugger', () =>
          window.webContents.debugger.sendCommand('Page.enable'),
        );
        ({identifier} = await uiOperation('Install fallback renderer', () =>
          window.webContents.debugger.sendCommand(
            'Page.addScriptToEvaluateOnNewDocument',
            {
              source: `(() => {
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function(type, ...args) {
              return ['webgl', '2d'].includes(type) ? null : getContext.call(this, type, ...args);
            };
          })();`,
            },
          ),
        ));
        await reloadPage();
        assert.equal(
          await evaluate(() => !document.getElementById('fallback').hidden),
          true,
          'Unavailable canvas graphics must reveal the fallback scene',
        );
        await evaluate(() =>
          [...document.querySelectorAll('#fallback-units button')]
            .find(item => item.textContent.includes('Queued agent'))
            .click(),
        );
        await settle();
        const fallback = await evaluate(() => {
          const station = document.querySelector(
            '#fallback-units [aria-pressed="true"]',
          );
          const other = document.querySelector(
            '#fallback-units [aria-pressed="false"]',
          );
          return {
            visible: !document.getElementById('fallback').hidden,
            inspector: document.getElementById('inspector-title').textContent,
            selected: station.classList.contains('selected'),
            name: station.querySelector('strong').textContent,
            color: getComputedStyle(station.querySelector('strong')).color,
            background: getComputedStyle(station).backgroundColor,
            otherBackground: getComputedStyle(other).backgroundColor,
            cardSelected: document
              .querySelector('#active-workers .selected')
              .textContent.includes('Queued agent'),
          };
        });
        assert.equal(fallback.visible, true);
        assert.equal(fallback.selected, true);
        assert.equal(fallback.name, 'Queued agent');
        assert.equal(fallback.inspector, 'Queued agent');
        assert.equal(fallback.cardSelected, true);
        assert.ok(contrast(fallback.color, fallback.background) >= 4.5);
        assert.ok(contrast(fallback.background, fallback.otherBackground) >= 3);
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot('selected-agent-fallback');
      } finally {
        try {
          if (identifier)
            await uiOperation('Remove fallback renderer', () =>
              window.webContents.debugger.sendCommand(
                'Page.removeScriptToEvaluateOnNewDocument',
                {identifier},
              ),
            );
        } finally {
          if (window.webContents.debugger.isAttached())
            window.webContents.debugger.detach();
        }
      }
    },
  );

  await run(
    'switching parents and restarting restores drafts and cursors; submitting clears recovery',
    async () => {
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Alpha unsent\nsecond line';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.setSelectionRange(3, 9);
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click();
      });
      await settle();
      const beta = await evaluate(
        () => document.getElementById('parent-prompt').value,
      );
      assert.equal(beta, '');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Beta unsent';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Alpha factory'))
          .click();
      });
      await settle();
      const alpha = await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        const before = editor.getBoundingClientRect().height;
        const handle = document.getElementById('parent-prompt-resize');
        handle.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
        return {
          draft: editor.value,
          start: editor.selectionStart,
          end: editor.selectionEnd,
          before,
          after: editor.getBoundingClientRect().height,
          handle: handle.getAttribute('role'),
          label: handle.getAttribute('aria-label'),
        };
      });
      assert.equal(alpha.draft, 'Alpha unsent\nsecond line');
      assert.equal(alpha.start, 3);
      assert.equal(alpha.end, 9);
      assert.equal(alpha.handle, 'separator');
      assert.equal(alpha.label, 'Resize message field');
      assert.ok(
        alpha.after > alpha.before,
        'Resize handle must grow the editor',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Beta unsent',
      );
      await reloadPage();
      assert.deepEqual(
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          return {
            value: editor.value,
            start: editor.selectionStart,
            end: editor.selectionEnd,
          };
        }),
        {value: 'Alpha unsent\nsecond line', start: 3, end: 9},
        'Restart recovers original parent text and selection',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Beta unsent',
        'Restart retains the other parent draft',
      );
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Submitted recovered draft did not clear',
      );
      assert.equal(
        await evaluate(() =>
          JSON.parse(
            window.localStorage.getItem('varisdev.composer-drafts.v1'),
          ).some(([id]) => id === 'beta'),
        ),
        false,
        'Acknowledged submission clears persisted recovery',
      );
      await reloadPage();
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '',
        'Submitted draft stays cleared after restart',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Alpha factory'))
          .click(),
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '',
        'Manually cleared draft stays cleared',
      );
      const storage = await evaluate(async () => {
        const {flushDrafts} = await import('./draft-storage.js');
        const editor = document.getElementById('parent-prompt');
        const draft = value => {
          editor.value = value;
          editor.dispatchEvent(new Event('input', {bubbles: true}));
        };
        draft('Persisted before quota failure');
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'varisdev.composer-drafts.v1')
            throw new DOMException('Storage full', 'QuotaExceededError');
          return original.call(this, key, value);
        };
        let blocked = false;
        let retained;
        try {
          draft('Editable through quota failure');
          try {
            flushDrafts();
          } catch {
            blocked = true;
          }
          retained =
            editor.value === 'Editable through quota failure' &&
            !document.getElementById('prompt-error').hidden &&
            JSON.parse(
              window.localStorage.getItem('varisdev.composer-drafts.v1'),
            ).some(
              ([, value]) => value.value === 'Persisted before quota failure',
            );
        } finally {
          Storage.prototype.setItem = original;
        }
        draft('Recovered from quota failure');
        flushDrafts();
        const recovered = document.getElementById('prompt-error').hidden;
        draft('');
        flushDrafts();
        return {blocked, retained, recovered};
      });
      assert.deepEqual(
        storage,
        {blocked: true, retained: true, recovered: true},
        'Quota failure preserves text and fails restart check until storage recovers',
      );
    },
  );

  for (const [width, height] of [
    [1100, 760],
    [1600, 1000],
  ]) {
    await run(
      `composer remains below conversation and visible at ${width}×${height}`,
      async () => {
        Object.assign(hub.sessions[0].session, {
          owned: false,
          controllable: true,
        });
        hub.sessions.push(
          ...Array.from({length: 8}, (_, index) =>
            session(`extra-${index}`, `Additional factory ${index}`),
          ),
        );
        hub.sessions[0].agents = Array.from({length: 16}, (_, index) => ({
          id: `layout-worker-${index}`,
          name: `Worker ${index}`,
          task: `Inspect the project and report detailed findings ${index}`,
          activity: 'Checking files and running the relevant tests',
          model: 'fixture/small',
          status: index < 8 ? 'running' : 'completed',
          createdAt: at,
          startedAt: at,
          ...(index >= 8 ? {finishedAt: at} : {}),
        }));
        hub.sessions[0].totalAgents = 16;
        hub.sessions[0].session.context = {
          percent: 25,
          tokens: 32000,
          window: 128000,
        };
        hub.sessions[0].conversation = Array.from({length: 30}, (_, index) => ({
          id: `layout-message-${index}`,
          role: index % 2 ? 'assistant' : 'user',
          at,
          text: `History message ${index}\n${'Readable history line\n'.repeat(4)}`,
        }));
        await publish();
        await evaluate(() => {
          document.getElementById('parent-prompt').style.height = '400px';
        });
        await settle();
        const geometry = await evaluate(() => {
          const composer = document.getElementById('composer-slot');
          const panel = document.getElementById('panel-conversation');
          const inspector = document.getElementById('inspector');
          const editor = document.getElementById('parent-prompt');
          const send = document.getElementById('send-prompt');
          const overview = document.querySelector('.overview');
          const cane = document.querySelector('.factory-cane-holster');
          const gun = document.querySelector('.factory-gun-holster');
          const menu = document.getElementById('app-menu-button');
          const rect = item => {
            const {top, bottom, left, right, height} =
              item.getBoundingClientRect();
            return {top, bottom, left, right, height};
          };
          return {
            viewport: {width: innerWidth, height: innerHeight},
            composer: rect(composer),
            panel: rect(panel),
            editor: rect(editor),
            form: rect(document.getElementById('prompt-form')),
            send: rect(send),
            inspector: rect(inspector),
            overview: rect(overview),
            cane: rect(cane),
            gun: rect(gun),
            menu: rect(menu),
            caneInMenu: cane.closest('#app-menu-weapons') !== null,
            gunInMenu: gun.closest('#app-menu-weapons') !== null,
            noCaneControlsOverScene: !document
              .getElementById('scene')
              .querySelector(
                '.factory-cane-holster, .factory-cane-hint, .factory-gun-holster, .factory-gun-hint',
              ),
            overviewInFactory:
              overview.parentElement.classList.contains('factory-column'),
            parent: composer.parentElement === inspector,
            follows: !!(
              panel.compareDocumentPosition(composer) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
            flex: getComputedStyle(inspector).display,
            workspaceInChanges: document
              .getElementById('panel-changes')
              .contains(document.querySelector('.workspace-section')),
            attachedNoteVisible:
              !document.getElementById('attached-note').hidden &&
              document.getElementById('attached-note').getClientRects().length >
                0,
            editorUsable:
              document.elementFromPoint(
                editor.getBoundingClientRect().left + 5,
                editor.getBoundingClientRect().bottom - 5,
              ) === editor,
            usable:
              document
                .elementFromPoint(
                  send.getBoundingClientRect().left + 5,
                  send.getBoundingClientRect().top + 5,
                )
                ?.closest('button') === send,
          };
        });
        assert.deepEqual(geometry.viewport, {width, height});
        assert.equal(geometry.parent, true);
        assert.equal(
          geometry.follows,
          true,
          'Composer must follow tab panels in DOM order',
        );
        assert.equal(geometry.flex, 'flex');
        assert.equal(geometry.workspaceInChanges, true);
        assert.equal(geometry.overviewInFactory, true);
        assert.equal(geometry.caneInMenu, true);
        assert.equal(geometry.gunInMenu, true);
        assert.equal(geometry.noCaneControlsOverScene, true);
        assert.equal(geometry.gun.height, 0);
        assert.ok(geometry.menu.right <= width);
        assert.equal(geometry.cane.height, 0);
        assert.ok(
          geometry.overview.right <= geometry.inspector.left,
          'Overview must sit in the factory column beside the inspector',
        );
        assert.ok(
          Math.abs(geometry.overview.top - geometry.inspector.top) <= 1,
          'Conversation inspector must begin beside the overview',
        );
        assert.equal(geometry.attachedNoteVisible, true);
        assert.ok(geometry.panel.height >= 90, JSON.stringify(geometry));
        assert.ok(
          geometry.composer.top >= geometry.panel.bottom - 1,
          JSON.stringify(geometry),
        );
        assert.ok(
          Math.abs(geometry.editor.left - geometry.form.left) <= 1 &&
            Math.abs(geometry.editor.right - geometry.form.right) <= 1,
          'Prompt field must fill the available form width',
        );
        assert.ok(
          geometry.send.top >= geometry.editor.bottom,
          'Prompt actions must sit below the field',
        );
        assert.ok(geometry.editor.height >= 40, JSON.stringify(geometry));
        assert.equal(
          geometry.editorUsable,
          true,
          'The bottom of a resized editor must remain visible and uncovered',
        );
        assert.ok(
          geometry.editor.top >= 0 && geometry.send.bottom <= height,
          JSON.stringify(geometry),
        );
        assert.ok(
          geometry.editor.left >= 0 && geometry.editor.right <= width,
          JSON.stringify(geometry),
        );
        assert.equal(
          geometry.usable,
          true,
          'Send button must be visible and uncovered',
        );
        const scroll = await evaluate(() => {
          const controls = document.querySelector('.app-controls');
          const before = controls.getBoundingClientRect().top;
          const column = document.querySelector('.factory-column');
          const conversation = document.getElementById('panel-conversation');
          column.scrollTop = 200;
          const lists = ['parents', 'active-workers', 'history-workers'].map(
            id => {
              const list = document.getElementById(id);
              list.scrollTop = 120;
              return {id, top: list.scrollTop};
            },
          );
          conversation.scrollTop = 120;
          conversation.dispatchEvent(new Event('scroll'));
          return {
            before,
            after: controls.getBoundingClientRect().top,
            factory: column.scrollTop,
            factoryOverflow: column.scrollHeight - column.clientHeight,
            mainOverflow:
              document.querySelector('main').scrollHeight -
              document.querySelector('main').clientHeight,
            lists,
            conversation: conversation.scrollTop,
            body: document.body.scrollTop,
            document: document.scrollingElement.scrollTop,
            window: window.scrollY,
            bodyOverflow: getComputedStyle(document.body).overflow,
            htmlOverflow: getComputedStyle(document.documentElement).overflow,
            composerBottom: document
              .getElementById('composer-slot')
              .getBoundingClientRect().bottom,
          };
        });
        assert.equal(scroll.factory, 0, 'The factory column must not scroll');
        assert.ok(scroll.factoryOverflow <= 1, JSON.stringify(scroll));
        assert.ok(scroll.mainOverflow <= 1, JSON.stringify(scroll));
        assert.ok(scroll.conversation > 0, JSON.stringify(scroll));
        for (const list of scroll.lists)
          assert.ok(
            list.top > 0,
            `${list.id} must keep overflowing entries accessible`,
          );
        assert.equal(
          scroll.after,
          scroll.before,
          'App controls must remain visible while lists and conversation scroll',
        );
        assert.equal(scroll.body, 0);
        assert.equal(scroll.document, 0);
        assert.equal(scroll.window, 0);
        assert.equal(scroll.bodyOverflow, 'hidden');
        assert.equal(scroll.htmlOverflow, 'hidden');
        assert.ok(scroll.composerBottom <= height, JSON.stringify(scroll));
        const factoryGeometry = async () =>
          evaluate(() => {
            const selectors = [
              '#overview-title',
              '#factory-title',
              '#scene',
              '#inspect-parent',
              ...(document.getElementById('factory-agents-button').hidden
                ? [
                    '#workers-title',
                    '#active-workers',
                    '#history-title',
                    '#history-search',
                    '#history-workers',
                  ]
                : ['#factory-agents-button']),
            ];
            return selectors.map(selector => {
              const element = document.querySelector(selector);
              const rect = element.getBoundingClientRect();
              return {
                selector,
                height: rect.height,
                visible:
                  rect.top >= 0 &&
                  rect.bottom <= innerHeight &&
                  rect.left >= 0 &&
                  rect.right <= innerWidth &&
                  element.contains(
                    document.elementFromPoint(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2,
                    ),
                  ),
              };
            });
          });
        for (const item of await factoryGeometry()) {
          assert.equal(item.visible, true, JSON.stringify(item));
          assert.ok(item.height > 0, JSON.stringify(item));
          if (item.selector === '#scene')
            assert.ok(item.height >= 90, JSON.stringify(item));
        }
        await evaluate(() => {
          const search = document.getElementById('history-search');
          search.value = 'Worker 15';
          search.dispatchEvent(new Event('input', {bubbles: true}));
          document.querySelector('#history-workers button').click();
        });
        assert.equal(
          await evaluate(
            () => document.getElementById('inspector-title').textContent,
          ),
          'Worker 15',
        );
        await evaluate(() => document.getElementById('inspect-parent').click());
        await settle();
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`factory-populated-${width}x${height}`);
        window.webContents.setZoomFactor(1.25);
        await settle();
        for (const item of await factoryGeometry())
          assert.equal(
            item.visible,
            true,
            `At 125% zoom: ${JSON.stringify(item)}`,
          );
        assert.equal(
          await evaluate(() => {
            const button = document.getElementById('send-prompt');
            const rect = button.getBoundingClientRect();
            return (
              rect.bottom <= innerHeight &&
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) === button
            );
          }),
          true,
          'Steer must remain visible after zooming with a resized editor',
        );
        window.webContents.setZoomFactor(1);
        await settle();
        await evaluate(() => document.getElementById('tab-changes').click());
        await settle();
        assert.equal(
          await evaluate(() => {
            const workspace = document.querySelector('.workspace-section');
            return (
              workspace.getClientRects().length > 0 &&
              !workspace.closest('[hidden]')
            );
          }),
          true,
        );
        await evaluate(() =>
          document.getElementById('tab-conversation').click(),
        );
        hub.sessions = [
          session('alpha', 'Alpha factory'),
          session('beta', 'Beta factory'),
        ];
        await publish();
        await evaluate(() => {
          document.querySelector('.factory-column').scrollTop = 0;
        });
        await evaluate(() => {
          document.getElementById('parent-prompt').style.height = '';
        });
        await settle();
      },
      width,
      height,
    );
  }

  await run(
    'conversation switches follow bottom, snapshots preserve readers and long outputs share one scroll',
    async () => {
      hub.sessions[0].conversation = Array.from({length: 35}, (_, index) => ({
        id: `history-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        at,
        text: `Message ${index}\n${'Readable history line\n'.repeat(4)}`,
      }));
      await publish();
      await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop = panel.scrollHeight;
        document.getElementById('follow-conversation').checked = true;
      });
      hub.sessions[0].conversation.at(-1).text += 'Live addition\n'.repeat(8);
      await publish();
      const bottomGap = await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        return panel.scrollHeight - panel.clientHeight - panel.scrollTop;
      });
      assert.ok(bottomGap < 4, `Follow left ${bottomGap}px below the viewport`);
      assert.equal(
        await evaluate(() => {
          const panel = document
            .getElementById('panel-conversation')
            .getBoundingClientRect();
          const follow = document.getElementById('follow-conversation');
          const bounds = follow.getBoundingClientRect();
          return (
            bounds.top >= panel.top &&
            bounds.bottom <= panel.bottom &&
            document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ) === follow
          );
        }),
        true,
        'Follow stays visible and clickable while reading the conversation bottom',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('conversation-follow-controls');
      await new Promise(resolve => setTimeout(resolve, 150));
      await settle();
      for (const cursor of ['text', 'padding']) {
        const point = await evaluate(cursor => {
          const panel = document.getElementById('panel-conversation');
          const body = panel.getBoundingClientRect();
          const text = document
            .querySelector('#conversation li:last-child .conversation-text')
            .getBoundingClientRect();
          return {
            x: Math.round(
              cursor === 'padding' ? body.left + 4 : text.left + 30,
            ),
            y: Math.round(
              Math.max(
                body.top + 20,
                Math.min(body.bottom - 35, text.bottom - 20),
              ),
            ),
          };
        }, cursor);
        window.webContents.sendInputEvent({
          type: 'mouseWheel',
          ...point,
          deltaY: 24,
          deltaX: 0,
        });
        await new Promise(resolve => setTimeout(resolve, 80));
        await settle();
        const reading = await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          return {
            top: panel.scrollTop,
            gap: panel.scrollHeight - panel.clientHeight - panel.scrollTop,
          };
        });
        assert.ok(
          reading.gap > 10 && reading.gap < 70,
          `A small upward wheel over ${cursor} must move up: ${JSON.stringify(reading)}`,
        );
        hub.sessions[0].conversation.at(-1).text +=
          `Streaming while reading over ${cursor}\n`.repeat(4);
        await publish();
        const streamedTop = await evaluate(
          () => document.getElementById('panel-conversation').scrollTop,
        );
        assert.ok(
          streamedTop <= reading.top + 1,
          `Streaming must not reverse an upward scroll over ${cursor}: ${JSON.stringify({reading, streamedTop})}`,
        );
        await new Promise(resolve => setTimeout(resolve, 180));
        const pausedTop = await evaluate(
          () => document.getElementById('panel-conversation').scrollTop,
        );
        hub.sessions[0].conversation.at(-1).text +=
          'More output while paused\n'.repeat(4);
        await publish();
        assert.ok(
          Math.abs(
            (await evaluate(
              () => document.getElementById('panel-conversation').scrollTop,
            )) - pausedTop,
          ) <= 1,
          `A reader over ${cursor} stays in place after the wheel settles`,
        );
        window.webContents.sendInputEvent({
          type: 'mouseWheel',
          ...point,
          deltaY: -320,
          deltaX: 0,
        });
        await until(() => {
          const panel = document.getElementById('panel-conversation');
          return panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 2;
        }, 'Scrolling down must reach the bottom');
        hub.sessions[0].conversation.at(-1).text +=
          'Follow resumes after scrolling down\n';
        await publish();
        await until(() => {
          const panel = document.getElementById('panel-conversation');
          return panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 2;
        }, 'Scrolling down to the bottom must resume follow');
      }
      await resizeKey('#panel-conversation', 'PageUp');
      const keyboardTop = await evaluate(
        () => document.getElementById('panel-conversation').scrollTop,
      );
      hub.sessions[0].conversation.at(-1).text +=
        'Streaming during keyboard navigation\n';
      await publish();
      assert.ok(
        (await evaluate(
          () => document.getElementById('panel-conversation').scrollTop,
        )) <=
          keyboardTop + 1,
        'PageUp must pause follow while output arrives',
      );
      await press('End');
      await until(() => {
        const panel = document.getElementById('panel-conversation');
        return panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 2;
      }, 'Keyboard navigation to the bottom resumes follow');
      const before = await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop = 100;
        panel.dispatchEvent(new Event('scroll'));
        return panel.scrollTop;
      });
      hub.sessions[0].conversation.at(-1).text +=
        'More streamed output\n'.repeat(8);
      await publish();
      const after = await evaluate(
        () => document.getElementById('panel-conversation').scrollTop,
      );
      assert.ok(
        Math.abs(after - before) <= 1,
        `Reading history moved from ${before} to ${after}`,
      );
      hub.sessions[1].conversation = hub.sessions[0].conversation.map(
        message => ({...message, id: `beta-${message.id}`}),
      );
      await publish();
      for (const name of ['Beta factory', 'Alpha factory']) {
        await evaluate(
          name =>
            [...document.querySelectorAll('#parents button')]
              .find(item => item.textContent.includes(name))
              .click(),
          name,
        );
        await settle();
        const position = await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          return {
            gap: panel.scrollHeight - panel.clientHeight - panel.scrollTop,
            follow: document.getElementById('follow-conversation').checked,
          };
        });
        assert.ok(
          position.gap < 4,
          `${name} restored an earlier position: ${JSON.stringify(position)}`,
        );
        assert.equal(position.follow, true);
        await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          panel.scrollTop = 120;
          panel.dispatchEvent(new Event('scroll'));
          document.getElementById('follow-conversation').checked = false;
          document
            .getElementById('follow-conversation')
            .dispatchEvent(new Event('change'));
        });
      }
      for (const tab of ['feed', 'context']) {
        await evaluate(
          tab => document.getElementById(`tab-${tab}`).click(),
          tab,
        );
        await evaluate(() =>
          document.getElementById('tab-conversation').click(),
        );
        await settle();
        assert.ok(
          await evaluate(() => {
            const panel = document.getElementById('panel-conversation');
            return (
              panel.scrollHeight - panel.clientHeight - panel.scrollTop < 4
            );
          }),
          `Returning from ${tab} must follow the conversation bottom`,
        );
      }
      await evaluate(() => {
        const last = document.querySelector('#conversation li:last-child');
        requestAnimationFrame(() => {
          last.style.paddingBottom = '260px';
        });
      });
      await settle();
      await settle();
      assert.ok(
        await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          return panel.scrollHeight - panel.clientHeight - panel.scrollTop < 4;
        }),
        'Deferred layout growth should stay at the bottom',
      );
      await evaluate(() => {
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop = 120;
        panel.dispatchEvent(new Event('scroll'));
        requestAnimationFrame(() => {
          document.querySelector(
            '#conversation li:last-child',
          ).style.paddingBottom = '420px';
        });
      });
      await settle();
      await settle();
      assert.equal(
        await evaluate(
          () => document.getElementById('panel-conversation').scrollTop,
        ),
        120,
        'Deferred layout must leave a reader in history',
      );

      hub.sessions[0].conversation.unshift({
        id: 'old-long-result',
        role: 'tool',
        toolName: 'bash',
        at,
        status: 'completed',
        input: JSON.stringify({command: 'printf long-result'}),
        text: 'Older result line\n'.repeat(80),
      });
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelector('#conversation details').open,
        ),
        false,
        'New tool results should start collapsed',
      );
      await evaluate(() => {
        const details = document.querySelector('#conversation details');
        details.open = true;
        const output = details.querySelector('.tool-output');
        const panel = document.getElementById('panel-conversation');
        panel.scrollTop +=
          output.getBoundingClientRect().top -
          panel.getBoundingClientRect().top +
          80;
        panel.dispatchEvent(new Event('scroll'));
      });
      // Opening a result changes layout and scroll anchoring asynchronously.
      // Measure the wheel baseline only after those updates have settled.
      await settle();
      const wheel = await evaluate(() => {
        const details = document.querySelector('#conversation details');
        const output = details.querySelector('.tool-output');
        const panel = document.getElementById('panel-conversation');
        const bounds = panel.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + 100),
          top: panel.scrollTop,
          open: details.open,
          nestedOverflow: output.scrollHeight - output.clientHeight,
          outputTop: output.scrollTop,
        };
      });
      assert.equal(wheel.open, true, 'A tool result opens when requested');
      assert.ok(
        wheel.nestedOverflow <= 1,
        'Tool results must have no nested vertical scroll',
      );
      window.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: wheel.x,
        y: wheel.y,
        deltaY: -160,
        deltaX: 0,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      await settle();
      const wheelAfter = await evaluate(() => ({
        top: document.getElementById('panel-conversation').scrollTop,
        nested: document.querySelector('#conversation .tool-output').scrollTop,
      }));
      assert.ok(
        wheelAfter.top > wheel.top,
        `Wheel over old output must scroll conversation: ${JSON.stringify({wheel, wheelAfter})}`,
      );
      assert.equal(wheelAfter.nested, 0);
      await evaluate(() =>
        document.querySelector('#conversation summary').click(),
      );
      hub.sessions[0].conversation.at(-1).text +=
        '\nSnapshot after deliberate collapse';
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelector('#conversation details').open,
        ),
        false,
        'A deliberate collapse should survive snapshots',
      );
    },
  );

  await run(
    'robot motion follows thinking writing and tool activity and respects Motion off',
    async () => {
      await evaluate(() => {
        if (
          document
            .getElementById('motion-toggle')
            .getAttribute('aria-pressed') !== 'true'
        )
          document.getElementById('motion-toggle').click();
      });
      hub.sessions[0].session.activity = 'Thinking';
      await publish();
      const bounds = await evaluate(() => {
        const rect = document
          .getElementById('factory-canvas')
          .getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(Math.min(rect.height, innerHeight - rect.y)),
        };
      });
      assert.equal(
        await evaluate(() => document.getElementById('factory-canvas').hidden),
        false,
        'The live scene must render',
      );
      const frame = async () => (await capturePage(bounds)).toBitmap();
      const thinking = await frame();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(
        thinking.equals(await frame()),
        false,
        'The working robot must visibly move between frames',
      );
      await evaluate(() => document.getElementById('motion-toggle').click());
      await settle();
      const still = await frame();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(
        still.equals(await frame()),
        true,
        'Motion off must freeze the scene',
      );
      hub.sessions[0].session.activity = 'Responding';
      await publish();
      await settle();
      const writing = await frame();
      assert.equal(
        still.equals(writing),
        false,
        'Writing must have a different pose from thinking',
      );
      hub.sessions[0].session.activity = 'Using bash';
      await publish();
      await settle();
      assert.equal(
        writing.equals(await frame()),
        false,
        'Tool use must have a different pose from writing',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('robot-tools');
      await evaluate(() => document.getElementById('motion-toggle').click());
    },
  );

  await run(
    'Speed startup reuses pending capabilities and preserves a new saved selection',
    async () => {
      const owner = hub.sessions[0];
      owner.session.model = 'openai/gpt-6-astra';
      owner.session.speedMode = 'fast';
      Object.assign(resources.get('alpha'), {
        model: {provider: 'openai', id: 'gpt-6-astra'},
        speedModes: ['regular', 'fast', 'ultrafast'],
        speedMode: 'fast',
      });
      const initial = Promise.withResolvers();
      featureGates.set('alpha', initial.promise);
      featureRequests.length = 0;
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        true,
        'Startup waits for its first capability response',
      );
      for (let index = 0; index < 3; index++) {
        await evaluate(() => {
          document.getElementById('tab-conversation').click();
          document.getElementById('tab-speed').click();
        });
      }
      await settle();
      assert.equal(
        featureRequests.filter(id => id === 'alpha').length,
        1,
        'Repeated Speed activation must reuse the initial request',
      );
      featureGates.delete('alpha');
      initial.resolve();
      await until(
        () =>
          !document.getElementById('session-speed').disabled &&
          document.getElementById('session-speed').value === 'fast',
        'The initial response must enable Speed without another click and restore the saved mode',
      );
      const stale = Promise.withResolvers();
      featureGates.set('alpha', stale.promise);
      await evaluate(() => {
        document.getElementById('tab-conversation').click();
        document.getElementById('tab-speed').click();
      });
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        false,
        'A background refresh must preserve confirmed startup capabilities',
      );
      await settle();
      featureGates.delete('alpha');
      await evaluate(() => document.getElementById('session-speed').focus());
      await press('End');
      await until(
        () =>
          !document.getElementById('session-speed').disabled &&
          document.getElementById('session-speed').value === 'ultrafast',
        'Keyboard selection must apply while an older capability request is pending',
      );
      assert.equal(owner.session.speedMode, 'ultrafast');
      assert.ok(
        calls.some(
          call =>
            call.method === 'prompt' &&
            call.sessionId === 'alpha' &&
            call.request.prompt === '/ultrafast on',
        ),
      );
      stale.resolve();
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').value),
        'ultrafast',
        'An older response must not overwrite the completed selection',
      );
      await reloadPage();
      await evaluate(() => document.getElementById('tab-speed').click());
      await until(
        () =>
          !document.getElementById('session-speed').disabled &&
          document.getElementById('session-speed').value === 'ultrafast',
        'The selected speed must survive a dashboard reload',
      );
    },
  );

  await run(
    'Speed first opening uses cached startup capabilities and model changes invalidate them',
    async () => {
      const owner = hub.sessions[0];
      owner.session.model = 'openai/gpt-6-astra';
      Object.assign(resources.get('alpha'), {
        model: {provider: 'openai', id: 'gpt-6-astra'},
        speedModes: ['regular', 'fast', 'ultrafast'],
      });
      await reloadPage();
      await until(
        () => !document.getElementById('session-speed').disabled,
        'Startup capabilities did not load before opening Speed',
      );
      const oldModel = Promise.withResolvers();
      featureGates.set('alpha', oldModel.promise);
      await evaluate(() => document.getElementById('tab-speed').click());
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        false,
        'The first Speed opening must immediately use cached startup capabilities',
      );
      await settle();
      const beforeModelChange = featureRequests.length;
      const newModel = Promise.withResolvers();
      featureGates.set('alpha', newModel.promise);
      owner.session.model = 'openai/gpt-5.4-nano';
      Object.assign(resources.get('alpha'), {
        model: {provider: 'openai', id: 'gpt-5.4-nano'},
        speedModes: ['regular'],
      });
      await publish();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        true,
        'An actual model change must wait for the new capabilities',
      );
      assert.ok(
        featureRequests.length > beforeModelChange,
        'Model changes must supersede the old in-flight request',
      );
      oldModel.resolve();
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        true,
        'A delayed supported-model response must not enable the new model',
      );
      newModel.resolve();
      await until(
        () =>
          document.getElementById('session-speed').disabled &&
          document.getElementById('speed-status').checkVisibility() &&
          document.querySelector('#session-speed option[value="fast"]')
            .disabled,
        'The new model must retain its Regular-only capability check',
      );
      const restored = Promise.withResolvers();
      featureGates.set('alpha', restored.promise);
      owner.session.model = 'anthropic/claude-opus-5';
      owner.session.speedMode = 'fast';
      Object.assign(resources.get('alpha'), {
        model: {provider: 'anthropic', id: 'claude-opus-5'},
        speedModes: ['regular', 'fast'],
        speedMode: 'fast',
      });
      await publish();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        true,
      );
      featureGates.delete('alpha');
      restored.resolve();
      await until(
        () =>
          !document.getElementById('session-speed').disabled &&
          document.getElementById('session-speed').value === 'fast' &&
          document.querySelector('#session-speed option[value="ultrafast"]')
            .disabled,
        'The replacement provider must enable its supported saved speed without another click',
      );
    },
  );

  await run(
    'selected agent controls configure context commands stop and close without touching its owner',
    async () => {
      const owner = hub.sessions[0];
      owner.session.agentProfile = {
        id: 'coordinator',
        name: 'Project coordinator',
        mode: 'primary',
      };
      owner.agents = [
        {
          id: 'controlled',
          name: 'Controlled agent',
          agentProfile: {
            id: 'reviewer',
            name: 'Review specialist',
            mode: 'all',
            color: '#FF6B6B',
          },
          cwd: directory,
          task: 'Continue the investigation',
          status: 'running',
          activity: 'Thinking',
          model: 'fixture/small',
          thinkingLevel: 'medium',
          resumable: true,
          createdAt: at,
          startedAt: at,
          conversation: [],
          queue: {
            steering: ['Recover this steering'],
            followUp: ['Recover this follow up'],
          },
        },
        {
          id: 'other',
          name: 'Other agent',
          agentMode: 'subagent',
          agentProfile: {
            id: 'explore',
            name: 'Discovery specialist',
            mode: 'subagent',
          },
          model: 'fixture/small',
          cwd: directory,
          task: 'Keep working',
          status: 'running',
          activity: 'Thinking',
          createdAt: at,
          conversation: [],
        },
      ];
      owner.totalAgents = 2;
      resources.set('alpha:controlled', {
        ...features({
          id: 'reviewer',
          name: 'Edited configuration name',
          mode: 'all',
          color: '#FF6B6B',
        }),
        speedModes: ['regular', 'fast'],
        commands: [
          ...features().commands,
          {name: 'fast', description: 'Toggle fast mode', source: 'extension'},
        ],
        contextFiles: [
          {
            path: '/fixture/controlled/AGENTS.md',
            name: 'AGENTS.md',
            kind: 'instructions',
            status: 'included',
            description: 'Selected agent instructions',
            content: '# Controlled agent context',
          },
        ],
      });
      resources.get('alpha').speedModes = ['regular', 'fast', 'ultrafast'];
      resources.set('alpha:other', {
        ...features(),
        speedModes: ['regular', 'fast', 'ultrafast'],
      });
      await publish();
      const speedIndicator = async (mode, label, glyph) => {
        owner.session.speedMode = mode;
        await publish();
        await settle();
        await evaluate(() => {
          const info = document.getElementById('factory-info');
          const button = document.getElementById('factory-info-button');
          if (
            button.checkVisibility() &&
            info.hasAttribute('popover') &&
            !info.matches(':popover-open')
          )
            button.click();
        });
        await settle();
        assert.deepEqual(
          await evaluate(() => {
            const icon = document.getElementById('factory-speed-mode');
            const effort = document.getElementById('factory-effort');
            const bounds = icon.getBoundingClientRect();
            const effortBounds = effort.getBoundingClientRect();
            return {
              hidden: icon.hidden,
              text: icon.textContent,
              label: icon.getAttribute('aria-label'),
              besideEffort:
                effort.nextElementSibling === icon &&
                Math.abs(bounds.top - effortBounds.top) < effortBounds.height &&
                bounds.left >= effortBounds.right,
              visible:
                icon.checkVisibility() &&
                bounds.width > 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight,
            };
          }),
          {
            hidden: false,
            text: glyph,
            label,
            besideEffort: true,
            visible: true,
          },
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(
            `speed-${mode}-${await evaluate(() => document.getElementById('factory-theme').value)}-${window.getContentSize()[0]}-${window.webContents.getZoomFactor()}`,
          );
        await evaluate(() => {
          const info = document.getElementById('factory-info');
          if (info.matches(':popover-open')) info.hidePopover();
        });
      };
      const originalSpeedTheme = await evaluate(
        () => document.getElementById('factory-theme').value,
      );
      const speedThemes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      for (const theme of speedThemes) {
        await evaluate(theme => {
          const select = document.getElementById('factory-theme');
          select.value = theme;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, theme);
        await speedIndicator('fast', 'Fast mode', '↯');
        await speedIndicator('ultrafast', 'Ultrafast mode', '↯↯');
      }
      await evaluate(theme => {
        const select = document.getElementById('factory-theme');
        select.value = theme;
        select.dispatchEvent(new Event('change', {bubbles: true}));
      }, originalSpeedTheme);
      window.setContentSize(1100, 760);
      window.webContents.setZoomFactor(1.5);
      await settle();
      await speedIndicator('ultrafast', 'Ultrafast mode', '↯↯');
      window.webContents.setZoomFactor(1);
      window.setContentSize(1600, 1000);
      owner.session.speedMode = 'regular';
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-speed-mode').hidden,
        ),
        true,
      );
      const configurationDetails = async (name, expected) => {
        await evaluate(() => document.getElementById('tab-details').click());
        assert.equal(
          await evaluate(() => {
            const label = [...document.querySelectorAll('#unit-facts dt')].find(
              item => item.textContent === 'Configuration',
            );
            return label?.nextElementSibling.textContent;
          }),
          expected,
        );
        for (const [width, height, zoom] of [
          [1600, 1000, 1],
          [1100, 760, 1.5],
        ]) {
          window.setContentSize(width, height);
          window.webContents.setZoomFactor(zoom);
          await settle();
          assert.equal(
            await evaluate(() => {
              const label = [
                ...document.querySelectorAll('#unit-facts dt'),
              ].find(item => item.textContent === 'Configuration');
              const value = label.nextElementSibling;
              const bounds = value.getBoundingClientRect();
              const panel = document
                .getElementById('panel-details')
                .getBoundingClientRect();
              return (
                bounds.width > 0 &&
                bounds.height > 0 &&
                bounds.top >= panel.top &&
                bounds.bottom <= panel.bottom &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight &&
                document.documentElement.scrollHeight <= innerHeight
              );
            }),
            true,
            `Configuration must be visible at ${width}x${height}, zoom ${zoom}`,
          );
          if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
            await screenshot(`configuration-details-${name}-${width}-${zoom}`);
        }
        window.webContents.setZoomFactor(1);
        window.setContentSize(1600, 1000);
        await settle();
        await evaluate(() =>
          document.getElementById('tab-conversation').click(),
        );
      };
      await configurationDetails('parent', 'Project coordinator (coordinator)');
      assert.equal(
        await evaluate(
          () => document.getElementById('agent-profile-label').textContent,
        ),
        'Project coordinator',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/fast on';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Parent speed command was not acknowledged',
      );
      assert.equal(owner.session.speedMode, 'fast');
      assert.ok(
        calls.some(
          call =>
            call.method === 'prompt' &&
            call.sessionId === 'alpha' &&
            call.request.prompt === '/fast on',
        ),
      );
      delete owner.session.controllable;
      await reloadPage();
      await evaluate(() => document.getElementById('tab-speed').click());
      await until(
        () =>
          !document.getElementById('session-speed').disabled &&
          document.getElementById('session-speed').value === 'fast',
        'An owned main agent without an explicit control flag must retain its Speed control after reload',
      );
      owner.session.controllable = false;
      await publish();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        true,
        'An explicit unavailable control flag takes precedence over ownership',
      );
      delete owner.session.controllable;
      await publish();
      await until(
        () => !document.getElementById('session-speed').disabled,
        'The owned main agent did not regain its Speed control',
      );
      window.setContentSize(1100, 760);
      await resizeZoom(1.5);
      assert.equal(
        await evaluate(() => {
          const control = document
            .getElementById('session-speed')
            .getBoundingClientRect();
          const panel = document
            .getElementById('panel-speed')
            .getBoundingClientRect();
          return (
            control.top >= panel.top &&
            control.bottom <= panel.bottom &&
            control.right <= panel.right &&
            document.getElementById('parent-prompt').checkVisibility()
          );
        }),
        true,
        'The Speed control fits alongside the composer at compact zoom',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('speed-tab-parent-compact');
      resources.get('alpha').speedModes = ['regular'];
      await evaluate(() => {
        document.getElementById('tab-conversation').click();
        document.getElementById('tab-speed').click();
      });
      await until(
        () =>
          document.getElementById('session-speed').disabled &&
          document.getElementById('speed-status').checkVisibility(),
        'Regular-only main models need a visible explanation for the disabled control',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('speed-tab-parent-unavailable-compact');
      resources.get('alpha').speedModes = ['regular', 'fast', 'ultrafast'];
      await evaluate(() => {
        document.getElementById('tab-conversation').click();
        document.getElementById('tab-speed').click();
      });
      await until(
        () =>
          !document.getElementById('session-speed').disabled &&
          document.getElementById('speed-status').hidden,
        'Supported main-agent capabilities did not restore the Speed control',
      );
      await resizeZoom(1);
      window.setContentSize(1600, 1000);
      await settle();
      await evaluate(() => document.getElementById('tab-conversation').click());
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Owner draft during speed changes';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await evaluate(() =>
        [...document.querySelectorAll('#active-workers button')]
          .find(item => item.textContent.includes('Other agent'))
          .click(),
      );
      await configurationDetails('subagent', 'Discovery specialist (explore)');
      const modelPromptsBeforeSwitch = calls.filter(
        call =>
          call.method === 'prompt' ||
          (call.method === 'agentSession' && call.request.action === 'prompt'),
      ).length;
      const reopenSpeedTab = async () => {
        await evaluate(() => {
          document.getElementById('tab-conversation').click();
          document.getElementById('tab-speed').click();
        });
      };
      await reopenSpeedTab();
      assert.deepEqual(
        await evaluate(() => ({
          selected: document
            .getElementById('tab-speed')
            .getAttribute('aria-selected'),
          panels: [...document.querySelectorAll('.inspector-body')]
            .filter(panel => !panel.hidden)
            .map(panel => panel.id),
          menuOpen: document
            .getElementById('app-menu-panel')
            .matches(':popover-open'),
          inPanel: !!document.querySelector('#panel-speed #session-speed'),
        })),
        {
          selected: 'true',
          panels: ['panel-speed'],
          menuOpen: false,
          inPanel: true,
        },
        'Speed is available as an inspector tab without opening the menu',
      );
      await evaluate(() => document.getElementById('tab-speed').focus());
      await press('Left');
      assert.notEqual(
        await evaluate(() => document.activeElement.id),
        'tab-speed',
      );
      await press('Right');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'tab-speed',
      );
      assert.equal(
        await evaluate(() =>
          document.getElementById('tab-speed').getAttribute('aria-selected'),
        ),
        'true',
        'Arrow navigation selects the Speed tab',
      );
      await until(
        () => !document.getElementById('session-speed').disabled,
        'Running subagent speed control did not load',
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-controls').hidden),
        true,
        'A subagent has no prompt composer',
      );
      for (const mode of ['fast', 'ultrafast', 'regular']) {
        await evaluate(mode => {
          const select = document.getElementById('session-speed');
          select.dataset.expected = mode;
          select.value = mode;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, mode);
        await until(() => {
          const select = document.getElementById('session-speed');
          return !select.disabled && select.value === select.dataset.expected;
        }, 'Subagent speed command did not settle');
        assert.equal(owner.agents[1].speedMode, mode);
        assert.equal(owner.agents[1].status, 'running');
        assert.equal(owner.session.speedMode, 'fast');
        assert.ok(
          calls.some(
            call =>
              call.method === 'agentSession' &&
              call.sessionId === 'alpha' &&
              call.request.agentId === 'other' &&
              call.request.action === 'command' &&
              call.request.command ===
                (mode === 'ultrafast'
                  ? '/ultrafast on'
                  : mode === 'fast'
                    ? '/fast on'
                    : '/fast off'),
          ),
        );
      }
      assert.equal(
        calls.filter(
          call =>
            call.method === 'prompt' ||
            (call.method === 'agentSession' &&
              call.request.action === 'prompt'),
        ).length,
        modelPromptsBeforeSwitch,
        'The switch sends no user prompts',
      );
      for (const theme of speedThemes) {
        await evaluate(theme => {
          const select = document.getElementById('factory-theme');
          select.value = theme;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, theme);
        await settle();
        assert.equal(
          await evaluate(() => {
            const select = document.getElementById('session-speed');
            const bounds = select.getBoundingClientRect();
            return (
              select.checkVisibility() &&
              bounds.top >= 0 &&
              bounds.bottom <= innerHeight &&
              bounds.right <= innerWidth
            );
          }),
          true,
          `Speed control must be visible in ${theme}`,
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`speed-tab-${theme}`);
      }
      await evaluate(theme => {
        const select = document.getElementById('factory-theme');
        select.value = theme;
        select.dispatchEvent(new Event('change', {bubbles: true}));
      }, originalSpeedTheme);
      window.setContentSize(1100, 760);
      window.webContents.setZoomFactor(1.5);
      await settle();
      assert.equal(
        await evaluate(() => {
          const select = document.getElementById('session-speed');
          const bounds = select.getBoundingClientRect();
          const panel = document
            .getElementById('panel-speed')
            .getBoundingClientRect();
          return (
            document.getElementById('tab-speed').checkVisibility() &&
            select.checkVisibility() &&
            bounds.top >= panel.top &&
            bounds.bottom <= panel.bottom &&
            bounds.right <= panel.right &&
            panel.bottom <= innerHeight &&
            document.documentElement.scrollHeight <= innerHeight
          );
        }),
        true,
        'Speed control and its tab must fit the compact panel',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('speed-tab-compact');
      window.webContents.setZoomFactor(1);
      window.setContentSize(1600, 1000);
      await settle();
      resources.get('alpha:other').speedModes = ['regular', 'fast'];
      await reopenSpeedTab();
      await until(
        () =>
          document.querySelector('#session-speed option[value="ultrafast"]')
            .disabled && !document.getElementById('session-speed').disabled,
        'Unsupported Anthropic Ultrafast option was not disabled',
      );
      assert.deepEqual(
        await evaluate(() =>
          [...document.getElementById('session-speed').options].map(
            option => option.value,
          ),
        ),
        ['regular', 'fast', 'ultrafast'],
      );
      resources.get('alpha:other').speedModes = ['regular'];
      featureDelays.set('alpha:other', 120);
      await reopenSpeedTab();
      assert.equal(
        await evaluate(() => document.getElementById('session-speed').disabled),
        false,
        'Confirmed same-model speed capabilities remain available while refreshing',
      );
      await until(
        () =>
          document.getElementById('session-speed').disabled &&
          document.querySelector('#session-speed option[value="fast"]')
            .disabled,
        'Unsupported model speed control was not disabled',
      );
      featureDelays.delete('alpha:other');
      assert.equal(
        await evaluate(() =>
          [...document.getElementById('session-speed').options]
            .filter(option => option.value !== 'regular')
            .every(option => option.disabled),
        ),
        true,
      );
      resources.get('alpha:other').speedModes = [
        'regular',
        'fast',
        'ultrafast',
      ];
      await reopenSpeedTab();
      await until(
        () => !document.getElementById('session-speed').disabled,
        'Restored model speed control did not refresh',
      );
      featureErrors.set('alpha:other', 'Fixture capability refresh failed');
      await reopenSpeedTab();
      await until(
        () =>
          document.getElementById('speed-error').checkVisibility() &&
          document.getElementById('session-speed').disabled,
        'Failed capability refresh left cached speed enabled',
      );
      featureErrors.delete('alpha:other');
      await reopenSpeedTab();
      await until(
        () => !document.getElementById('session-speed').disabled,
        'Speed control did not recover from capability refresh failure',
      );
      dialogErrors.set('speed', 'Fixture speed refused');
      await evaluate(() => {
        const select = document.getElementById('session-speed');
        select.value = 'ultrafast';
        select.dispatchEvent(new Event('change', {bubbles: true}));
      });
      await until(
        () =>
          document.getElementById('speed-error').checkVisibility() &&
          document.getElementById('session-speed').value === 'regular' &&
          !document.getElementById('session-speed').disabled,
        'Rejected speed change did not restore its confirmed mode and show an error',
      );
      assert.match(
        await evaluate(
          () => document.getElementById('speed-error').textContent,
        ),
        /Fixture speed refused/,
      );
      assert.equal(owner.agents[1].speedMode, 'regular');
      assert.equal(owner.session.speedMode, 'fast');
      dialogErrors.delete('speed');
      await reopenSpeedTab();
      assert.equal(
        await evaluate(() => document.getElementById('speed-error').hidden),
        true,
        'Reopening Speed clears the previous command error',
      );
      await evaluate(() => document.getElementById('tab-conversation').click());
      await evaluate(() => document.getElementById('back-to-parent').click());
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Owner draft during speed changes',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Root draft during worker stop';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await evaluate(() =>
        [...document.querySelectorAll('#active-workers button')]
          .find(item => item.textContent.includes('Controlled agent'))
          .click(),
      );
      assert.deepEqual(
        await evaluate(() => ({
          title: document.getElementById('factory-title').textContent,
          recipient: document.getElementById('prompt-recipient').textContent,
          composer: !document.getElementById('parent-controls').hidden,
          taskDock: document.getElementById('agent-task-dock').hidden,
          stop: document.getElementById('abort-parent').disabled,
        })),
        {
          title: 'Controlled agent',
          recipient: 'Controlled agent',
          composer: true,
          taskDock: true,
          stop: false,
        },
      );
      await configurationDetails('worker', 'Review specialist (reviewer)');
      await evaluate(() => {
        document.getElementById('tab-context').click();
        document.getElementById('refresh-context').click();
      });
      await until(
        () =>
          document
            .getElementById('context-files')
            .textContent.includes('Controlled agent context'),
        'Selected agent context did not load',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('context-recipient').textContent,
        ),
        'Controlled agent',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('agent-profile-label').textContent,
        ),
        'Review specialist',
      );
      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('open-session-settings').click();
      });
      await until(
        () =>
          document.getElementById('extension-dialog').open &&
          document.getElementById('extension-dialog-title').textContent ===
            'Model & thinking' &&
          !document.getElementById('extension-dialog-terminal').hidden,
        'Agent model terminal did not load',
      );
      assert.equal(
        await evaluate(() => document.getElementById('agent-settings-dialog')),
        null,
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'agentSession').at(-1),
        {
          method: 'agentSession',
          sessionId: 'alpha',
          request: {
            agentId: 'controlled',
            action: 'command',
            command: '/model',
          },
        },
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('selected-agent-settings');
      await evaluate(() =>
        document.getElementById('extension-dialog-action-session').click(),
      );
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Agent model terminal did not settle',
      );
      assert.deepEqual(
        calls
          .filter(
            call =>
              call.method === 'respondToDialog' &&
              call.value?.action === 'session',
          )
          .at(-1),
        {
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: 'worker-model:controlled',
          value: {action: 'session'},
        },
      );
      assert.equal(owner.agents[0].model, 'fixture/small');
      assert.equal(owner.agents[0].thinkingLevel, 'medium');
      assert.equal(owner.session.model, 'fixture/small');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/thinking low';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Agent thinking command was not acknowledged',
      );
      assert.equal(owner.agents[0].thinkingLevel, 'low');
      assert.equal(owner.session.thinkingLevel, 'medium');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/fast on';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Selected primary speed command was not acknowledged',
      );
      assert.equal(owner.agents[0].speedMode, 'fast');
      assert.equal(owner.session.speedMode, 'fast');
      assert.equal(owner.agents[1].speedMode, 'regular');
      assert.ok(
        calls.some(
          call =>
            call.method === 'agentSession' &&
            call.request.agentId === 'controlled' &&
            call.request.action === 'prompt' &&
            call.request.prompt === '/fast on',
        ),
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/approv';
        editor.focus();
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await until(
        () => !document.getElementById('command-suggestions').hidden,
        'Worker approvals suggestion did not appear',
      );
      await press('Return');
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '/approvals ',
      );
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      await until(
        () =>
          document.getElementById('extension-dialog').open &&
          document.getElementById('extension-dialog-title').textContent ===
            'Remembered approvals',
        'Worker approvals command did not open its native dialog',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'agentSession').at(-1),
        {
          method: 'agentSession',
          sessionId: 'alpha',
          request: {
            agentId: 'controlled',
            action: 'command',
            command: '/approvals',
          },
        },
      );
      await press('Escape');
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Worker approvals cancellation did not close its dialog',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Keep an unsent agent draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.focus();
      });
      abortDelay = 160;
      await press('Escape');
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(
            item =>
              item.querySelector('.parent-card-name').textContent ===
              'Alpha factory',
          )
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Root draft during worker stop',
      );
      assert.equal(
        await evaluate(() => document.getElementById('send-prompt').disabled),
        false,
      );
      await evaluate(() =>
        [...document.querySelectorAll('#history-workers button')]
          .find(
            item =>
              item.querySelector('.history-row-name').textContent ===
              'Controlled agent',
          )
          .click(),
      );
      await until(
        () => !document.getElementById('send-prompt').disabled,
        'Selected agent Stop did not settle',
      );
      assert.equal(owner.agents[0].status, 'cancelled');
      assert.equal(owner.agents[1].status, 'running');
      assert.equal(owner.session.status, 'running');
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Recover this steering\n\nRecover this follow up\n\nKeep an unsent agent draft',
      );
      await evaluate(() => {
        document.getElementById('open-commands').click();
        document.getElementById('command-search').value = 'compact';
        document
          .getElementById('command-search')
          .dispatchEvent(new Event('input', {bubbles: true}));
      });
      await until(
        () =>
          document
            .getElementById('command-catalog')
            .textContent.includes('/compact'),
        'Agent commands did not load',
      );
      await evaluate(() => {
        document.getElementById('compact-instructions').value =
          'Keep the findings';
        document.getElementById('compact-session').click();
      });
      await settle();
      assert.ok(
        calls.some(
          call =>
            call.method === 'agentSession' &&
            call.request.action === 'compact' &&
            call.request.instructions === 'Keep the findings',
        ),
      );
      await evaluate(() => document.getElementById('reload-session').click());
      await settle();
      assert.ok(
        calls.some(
          call =>
            call.method === 'agentSession' && call.request.action === 'reload',
        ),
      );
      await evaluate(() => document.getElementById('close-commands').click());
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('selected-agent-controls');
      await evaluate(() =>
        document.getElementById('close-parent-session').click(),
      );
      await until(
        () =>
          document.getElementById('inspector-title').textContent ===
          'Alpha factory',
        'Closing selected agent did not return to its owner',
      );
      assert.equal(owner.agents.length, 2);
      assert.equal(owner.agents[0].resumable, false);
      assert.equal(
        await evaluate(() =>
          [
            ...document.querySelectorAll(
              '#active-workers .worker-card-name, #history-workers .history-row-name',
            ),
          ].some(item => item.textContent === 'Controlled agent'),
        ),
        false,
      );
      assert.equal(hub.sessions.length, 2);
      assert.deepEqual(
        calls.filter(call =>
          [
            'prompt',
            'abort',
            'configureSession',
            'compactSession',
            'reloadSession',
            'closeSession',
            'cancelAgent',
          ].includes(call.method),
        ),
        [{method: 'prompt', sessionId: 'alpha', request: {prompt: '/fast on'}}],
      );
      assert.deepEqual(
        calls
          .filter(
            call =>
              call.method === 'agentSession' && call.request.action === 'close',
          )
          .map(call => [call.sessionId, call.request.agentId]),
        [['alpha', 'controlled']],
      );
    },
  );

  await run(
    'Escape stops parent work once preserves the draft and resumes parent visuals on the next run',
    async () => {
      hub.sessions[0].session.activity = 'Thinking about the next operation';
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('processing-bubble-text').textContent,
        ),
        'Thinking',
      );
      assert.equal(
        await evaluate(() =>
          document.getElementById('scene').classList.contains('is-processing'),
        ),
        true,
      );
      assert.match(
        await evaluate(
          () => document.getElementById('abort-parent').textContent,
        ),
        /Stop.*Esc/,
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Keep this unsent draft\nsecond line';
        editor.focus();
        editor.setSelectionRange(5, 16, 'backward');
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        window.fixtureRepeat = false;
        editor.addEventListener('keydown', event => {
          if (event.key === 'Escape' && event.repeat)
            window.fixtureRepeat = true;
        });
        editor.dispatchEvent(new Event('compositionstart', {bubbles: true}));
      });
      await press('Escape');
      assert.deepEqual(
        calls,
        [],
        'Escape during composition must preserve the active task',
      );
      await evaluate(() =>
        document
          .getElementById('parent-prompt')
          .dispatchEvent(new Event('compositionend', {bubbles: true})),
      );
      await press('Escape');
      await press('Escape', ['isautorepeat']);
      assert.equal(
        await evaluate(() => window.fixtureRepeat),
        true,
        'The repeated native key event must carry the browser repeat flag',
      );
      assert.deepEqual(calls, [
        {method: 'abort', sessionId: 'alpha', request: undefined},
      ]);
      const draft = () => {
        const editor = document.getElementById('parent-prompt');
        return {
          value: editor.value,
          start: editor.selectionStart,
          end: editor.selectionEnd,
          direction: editor.selectionDirection,
        };
      };
      const expectedDraft = {
        value: 'Keep this unsent draft\nsecond line',
        start: 5,
        end: 16,
        direction: 'backward',
      };
      assert.deepEqual(await evaluate(draft), expectedDraft);
      assert.deepEqual(
        await evaluate(() => ({
          processing: document
            .getElementById('scene')
            .classList.contains('is-processing'),
          stopping: document
            .getElementById('scene')
            .classList.contains('is-stopping'),
          bubbleHidden: document.getElementById('processing-bubble').hidden,
          status: document.getElementById('processing-state-text').textContent,
          paused: document
            .getElementById('processing-state')
            .classList.contains('paused'),
          indicator: getComputedStyle(
            document.querySelector('#processing-state > i'),
          ).animationName,
          activityIndicator: getComputedStyle(
            document.querySelector('#conversation-activity .activity-dot'),
          ).animationName,
          yellowBurst: !!document.getElementById('stop-burst'),
          effect: document
            .getElementById('scene')
            .classList.contains('is-startled'),
          alert: getComputedStyle(document.getElementById('scene'), '::before')
            .animationName,
        })),
        {
          processing: false,
          stopping: false,
          bubbleHidden: true,
          status: '—',
          paused: true,
          indicator: 'none',
          activityIndicator: 'none',
          yellowBurst: false,
          effect: true,
          alert: 'factory-alert',
        },
      );
      // A fast cancellation must still let the reaction finish.
      Object.assign(hub.sessions[0].session, {
        status: 'idle',
        activity: 'Ready',
      });
      Object.assign(hub.sessions[0].conversation.at(-1), {
        status: 'cancelled',
        streaming: false,
        finishedAt: at,
      });
      await publish();
      await evaluate(() => {
        const scene = document.getElementById('scene');
        // Keep the actual canvas in view and compare its geometry without the
        // CSS alert tint changing pixels around it.
        scene.scrollIntoView({block: 'center'});
        scene.classList.remove('is-startled');
        const canvas = document.getElementById('factory-canvas');
        const gl = canvas.getContext('webgl');
        window.fixtureGeometry = new Map();
        if (!gl) {
          window.fixturePixels = () => {
            const pixels = canvas
              .getContext('2d')
              .getImageData(0, 0, canvas.width, canvas.height).data;
            window.fixtureGeometry.set('pixels', pixels);
          };
          window.fixturePixels();
          return;
        }
        const bufferSubData = gl.bufferSubData.bind(gl);
        gl.bufferSubData = (target, offset, data) => {
          if (
            gl.getBufferParameter(target, gl.BUFFER_USAGE) === gl.DYNAMIC_DRAW
          )
            window.fixtureGeometry.set(
              gl.getParameter(gl.ARRAY_BUFFER_BINDING),
              new Float32Array(data),
            );
          bufferSubData(target, offset, data);
        };
      });
      await settle();
      const geometry = () =>
        evaluate(() => {
          window.fixturePixels?.();
          return [...window.fixtureGeometry.values()].map(data => {
            const bytes = new Uint8Array(data.buffer);
            let hash = 2166136261;
            for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
            return {length: data.length, hash: hash >>> 0};
          });
        });
      await until(
        () =>
          [...window.fixtureGeometry.values()].some(data => data.length > 0),
        'The stopped robot did not upload its reaction geometry',
      );
      const stoppedGeometry = await geometry();
      assert.ok(
        stoppedGeometry.some(buffer => buffer.length > 0),
        'The stopped robot must upload its reaction pose',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() =>
          document.getElementById('scene').classList.add('is-startled'),
        );
        await screenshot('startled-robot');
        await evaluate(() =>
          document.getElementById('scene').classList.remove('is-startled'),
        );
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
      // Actual reaction motion is covered with controlled frames in the
      // parent animation test; hidden Electron windows may suspend scene RAF.
      assert.deepEqual(
        await evaluate(() => {
          const canvas = document.getElementById('factory-canvas');
          return {
            mode: canvas.dataset.parentMode,
            eyesOpen: Number(canvas.dataset.parentEyes) >= 0.24,
          };
        }),
        {mode: 'rest', eyesOpen: true},
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('processing-state').hidden,
        ),
        true,
      );
      Object.assign(hub.sessions[0].session, {
        status: 'running',
        activity: 'Writing the next response',
      });
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          processing: document
            .getElementById('scene')
            .classList.contains('is-processing'),
          stopping: document
            .getElementById('scene')
            .classList.contains('is-stopping'),
          bubbleVisible: !document.getElementById('processing-bubble').hidden,
          phase: document.getElementById('processing-state-text').textContent,
          paused: document
            .getElementById('processing-state')
            .classList.contains('paused'),
          activityPaused: document
            .getElementById('conversation-activity')
            .classList.contains('paused'),
        })),
        {
          processing: true,
          stopping: false,
          bubbleVisible: true,
          phase: 'Writing',
          paused: false,
          activityPaused: false,
        },
      );
      assert.deepEqual(await evaluate(draft), expectedDraft);
      assert.equal(calls.length, 1);
      await evaluate(() => {
        document.getElementById('motion-toggle').click();
        document.getElementById('abort-parent').click();
      });
      await settle();
      assert.equal(
        await evaluate(
          () =>
            getComputedStyle(document.getElementById('scene'), '::before')
              .animationName,
        ),
        'none',
        'Motion off must use a static alert',
      );
      const stillGeometry = await geometry();
      assert.ok(stillGeometry.some(buffer => buffer.length > 0));
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.deepEqual(
        await geometry(),
        stillGeometry,
        'Motion off must keep the robot geometry still during Stop',
      );
      assert.equal(calls.filter(call => call.method === 'abort').length, 2);
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      assert.equal(
        await evaluate(() =>
          document.getElementById('scene').classList.contains('is-startled'),
        ),
        false,
        'Stopping one parent must not flash another parent’s factory',
      );
    },
  );

  await run(
    'skill palette, slash commands and agent mentions insert before sending arguments',
    async () => {
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'explain the file';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('open-commands').click();
      });
      const {nativeCommands} = await import(
        pathToFileURL(resolve('assets/dashboard/command-catalog.js')).href
      );
      await until(
        () =>
          [...document.querySelectorAll('#command-catalog strong')].some(
            item => item.textContent === '/fixture-command',
          ),
        'Skill catalog did not load from sessionFeatures',
      );
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#command-catalog button').length,
        ),
        nativeCommands.length + 3,
        'Every native command and each plugin resource is listed exactly once',
      );
      const catalog = await evaluate(() => ({
        open: document.getElementById('commands-dialog').open,
        text: document.getElementById('command-catalog').textContent,
        tools: document.getElementById('available-tools').textContent,
      }));
      assert.equal(catalog.open, true);
      for (const source of ['Skill', 'Template', 'Extension', 'Command'])
        assert.ok(catalog.text.includes(source), `Catalog missing ${source}`);
      assert.match(catalog.tools, /bash/);
      await evaluate(() =>
        [...document.querySelectorAll('#command-catalog button')]
          .find(item => item.textContent.includes('/skill:inspect'))
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '/skill:inspect explain the file',
      );
      assert.equal(
        await evaluate(() => document.getElementById('commands-dialog').open),
        true,
      );
      await evaluate(() => document.getElementById('close-commands').click());
      assert.deepEqual(calls, [], 'Selecting a skill must only edit the draft');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/skill:in';
        editor.focus();
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await until(
        () => !document.getElementById('command-suggestions').hidden,
        'Slash suggestions did not appear',
      );
      await press('Return');
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '/skill:inspect ',
      );
      assert.deepEqual(
        calls,
        [],
        'Autocomplete Enter must not submit a prompt',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value += 'src/index.ts';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await press('Return');
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Prompt with arguments did not submit',
      );
      assert.deepEqual(calls, [
        {
          method: 'prompt',
          sessionId: 'alpha',
          request: {prompt: '/skill:inspect src/index.ts'},
        },
      ]);
      for (const command of ['/thinking', '/settings']) {
        await evaluate(command => {
          const editor = document.getElementById('parent-prompt');
          editor.value = command;
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          document.getElementById('prompt-form').requestSubmit();
        }, command);
        await until(
          () => document.getElementById('extension-dialog').matches(':modal'),
          `${command} did not route to the session-native dialog`,
        );
        assert.deepEqual(
          calls.filter(call => call.method === 'prompt').at(-1),
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: command},
          },
        );
        assert.equal(
          await evaluate(() =>
            document.getElementById('session-settings-dialog'),
          ),
          null,
          'The separate model defaults editor must be removed',
        );
        assert.deepEqual(
          await evaluate(() => ({
            terminal: !document.getElementById('extension-dialog-terminal')
              .hidden,
            selectHidden: document.getElementById('extension-dialog-select')
              .hidden,
            continueHidden: document.getElementById('submit-extension-dialog')
              .hidden,
          })),
          {terminal: true, selectHidden: true, continueHidden: true},
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(
            command === '/thinking'
              ? 'thinking-native-terminal'
              : 'settings-native-terminal',
          );
        if (command === '/thinking') {
          assert.equal(
            await evaluate(
              () =>
                document.getElementById('extension-dialog-title').textContent,
            ),
            'Thinking level',
          );
          await press('Down');
          for (let attempt = 0; attempt < 50; attempt++) {
            if (hub.sessions[0].ui.dialogs[0]?.selection === 3) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(
            hub.sessions[0].ui.dialogs[0]?.selection,
            3,
            `Thinking keyboard response: ${JSON.stringify(
              calls.filter(call => call.method === 'respondToDialog').slice(-4),
            )}`,
          );
          await press('Return');
          await until(
            () => !document.getElementById('extension-dialog').open,
            'Thinking selection did not close',
          );
          assert.equal(hub.sessions[0].session.thinkingLevel, 'high');
        } else {
          assert.equal(
            await evaluate(
              () =>
                document.getElementById('extension-dialog-title').textContent,
            ),
            'Settings',
          );
          if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
            const themes = await evaluate(() =>
              [...document.getElementById('factory-theme').options].map(
                option => option.value,
              ),
            );
            for (const theme of themes) {
              await evaluate(theme => {
                const select = document.getElementById('factory-theme');
                select.value = theme;
                select.dispatchEvent(new Event('change'));
              }, theme);
              await screenshot(`settings-native-${theme}`);
            }
            await evaluate(() => {
              const select = document.getElementById('factory-theme');
              select.value = window.fixtureTheme || 'factory';
              select.dispatchEvent(new Event('change'));
            });
          }
          for (const [width, height, zoom] of [
            [900, 760, 1.5],
            [900, 760, 2],
            [1600, 1000, 1],
          ]) {
            window.setContentSize(width, height);
            window.webContents.setZoomFactor(zoom);
            await settle();
            assert.deepEqual(
              await evaluate(() => {
                const dialog = document
                  .getElementById('extension-dialog')
                  .getBoundingClientRect();
                const terminal = document
                  .getElementById('extension-dialog-terminal')
                  .getBoundingClientRect();
                const cancel = document
                  .getElementById('cancel-extension-dialog')
                  .getBoundingClientRect();
                return {
                  dialogFits:
                    dialog.left >= 0 &&
                    dialog.right <= innerWidth &&
                    dialog.top >= 0 &&
                    dialog.bottom <= innerHeight,
                  terminalVisible: terminal.width > 120 && terminal.height > 60,
                  cancelVisible:
                    cancel.top >= dialog.top && cancel.bottom <= dialog.bottom,
                };
              }),
              {
                dialogFits: true,
                terminalVisible: true,
                cancelVisible: true,
              },
            );
            if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
              await screenshot(`settings-native-${width}-${zoom}`);
          }
          await press('Return');
          await until(
            () =>
              document.getElementById('extension-dialog-title').textContent ===
              'Auto retry',
            'Settings did not route responses to its submenu',
          );
          assert.equal(
            await evaluate(
              () => document.getElementById('extension-dialog-select').hidden,
            ),
            true,
          );
          await press('Escape');
          await until(
            () => !document.getElementById('extension-dialog').open,
            'Settings cancellation did not close the native dialog',
          );
        }
      }
      for (const [typed, inserted] of [
        ['@rev', '@review'],
        ['@agent:team', '@agent:team/review'],
        ['@agent:"My Agent', '@agent:"My Agent (Ä).test"'],
        ['@agent:"Agent \\"Q', '@agent:"Agent \\"Quoted\\""'],
        ['@Ää', '@Äänekäs'],
        ['@.Hidden', '@.Hidden.Agent'],
      ]) {
        const promptCount = calls.filter(
          call => call.method === 'prompt',
        ).length;
        await evaluate(value => {
          const editor = document.getElementById('parent-prompt');
          editor.value = value;
          editor.focus();
          editor.dispatchEvent(new Event('input', {bubbles: true}));
        }, typed);
        await until(
          () => !document.getElementById('command-suggestions').hidden,
          'Agent mention suggestions did not appear',
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR && typed === '@rev') {
          await screenshot('agent-mention-normal');
          window.setContentSize(900, 760);
          window.webContents.setZoomFactor(1.5);
          await settle();
          await screenshot('agent-mention-compact');
          window.setContentSize(1600, 1000);
          window.webContents.setZoomFactor(1);
          await settle();
        }
        await press('Tab');
        assert.equal(
          await evaluate(() => document.getElementById('parent-prompt').value),
          `${inserted} `,
        );
        assert.equal(
          calls.filter(call => call.method === 'prompt').length,
          promptCount,
          'Selecting a mention must only edit the draft',
        );
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          editor.value += 'Inspect the changed files';
          editor.dispatchEvent(new Event('input', {bubbles: true}));
        });
        await press('Return');
        await until(
          () => document.getElementById('parent-prompt').value === '',
          'The manual subagent task did not submit',
        );
        assert.deepEqual(
          calls.filter(call => call.method === 'prompt').at(-1),
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: `${inserted} Inspect the changed files`},
          },
        );
      }
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '@src/index.ts';
        editor.focus();
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      assert.equal(
        await evaluate(
          () => document.getElementById('command-suggestions').hidden,
        ),
        true,
        'File mentions are not agent suggestions',
      );
    },
  );

  await run(
    'Menu Model shares the session model picker during active work and preserves the draft',
    async () => {
      const draft = 'Unsent model menu draft';
      await evaluate(draft => {
        const editor = document.getElementById('parent-prompt');
        editor.value = draft;
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      }, draft);
      for (const [status, action] of [
        ['idle', 'default'],
        ['running', 'session'],
        ['compacting', 'session'],
      ]) {
        hub.sessions[0].session.status = status;
        if (status === 'running') {
          hub.sessions[0].agents = [
            {
              id: 'model-worker',
              name: 'Model worker',
              task: 'Keep working',
              model: 'fixture/small',
              status: 'running',
              activity: 'Working',
              createdAt: at,
              startedAt: at,
              conversation: [],
            },
          ];
          hub.sessions[0].totalAgents = 1;
        }
        await publish();
        await evaluate(() => {
          document.getElementById('app-menu-button').click();
          document.getElementById('open-session-settings').click();
        });
        await until(
          () =>
            document.getElementById('extension-dialog').open &&
            document.getElementById('extension-dialog-title').textContent ===
              'Model & thinking',
          'Menu Model & thinking did not open the session model picker',
        );
        assert.deepEqual(
          calls.filter(call => call.method === 'prompt').at(-1),
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: '/model'},
          },
        );
        assert.deepEqual(
          await evaluate(() => ({
            draft: document.getElementById('parent-prompt').value,
            oldDialog: document.getElementById('session-settings-dialog'),
            oldAPI: typeof window.pidev.getModelDefaults,
            terminal: !document.getElementById('extension-dialog-terminal')
              .hidden,
            parentView: !document.getElementById('parent-controls').hidden,
            actions: [
              ...document.querySelectorAll('#extension-dialog-actions button'),
            ]
              .filter(item => !item.hidden)
              .map(item => item.textContent.trim()),
            continueHidden: document.getElementById('submit-extension-dialog')
              .hidden,
          })),
          {
            draft,
            oldDialog: null,
            oldAPI: 'undefined',
            terminal: true,
            parentView: true,
            actions: ['Make as default', 'Apply to session'],
            continueHidden: true,
          },
        );
        assert.equal(hub.sessions[0].session.status, status);
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR && status === 'idle')
          await screenshot('model-selector');
        await evaluate(
          action =>
            document
              .getElementById(`extension-dialog-action-${action}`)
              .click(),
          action,
        );
        await until(
          () => !document.getElementById('extension-dialog').open,
          'The selector action did not settle',
        );
        assert.deepEqual(
          calls
            .filter(
              call => call.method === 'respondToDialog' && call.value?.action,
            )
            .at(-1),
          {
            method: 'respondToDialog',
            sessionId: 'alpha',
            dialogId: 'native-model',
            value: {action},
          },
        );
      }
      hub.sessions[0].session.status = 'running';
      await publish();
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/model';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => document.getElementById('extension-dialog').open,
        '/model did not open the same picker',
      );
      assert.deepEqual(calls.filter(call => call.method === 'prompt').at(-1), {
        method: 'prompt',
        sessionId: 'alpha',
        request: {prompt: '/model'},
      });
      hub.sessions[0].ui.dialogs[0].keepOpen = true;
      await evaluate(() =>
        document.getElementById('extension-dialog-action-default').click(),
      );
      await until(
        () =>
          !document.getElementById('extension-dialog-action-default').disabled,
        'The pending action did not finish',
      );
      assert.equal(
        await evaluate(() => document.getElementById('extension-dialog').open),
        true,
        'An action without a selection must leave the picker open',
      );
      await evaluate(() =>
        document.getElementById('cancel-extension-dialog').click(),
      );
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Cancel did not close the picker',
      );
      assert.equal(hub.sessions[0].session.status, 'running');
    },
  );

  await run(
    'extension dialogs return values and native cancellation alongside notifications',
    async () => {
      hub.sessions[0].ui = {
        dialogs: [],
        notifications: [
          {id: 'notice-1', type: 'info', message: 'Fixture extension ready'},
        ],
        statuses: [{key: 'fixture', text: 'Waiting for your choice'}],
        editor: {id: 'editor-1', text: 'Draft from extension'},
      };
      await publish();
      assert.match(
        await evaluate(
          () => document.getElementById('extension-notifications').textContent,
        ),
        /Fixture extension ready/,
      );
      assert.match(
        await evaluate(
          () => document.getElementById('extension-statuses').textContent,
        ),
        /Waiting for your choice/,
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Draft from extension',
      );
      await evaluate(() =>
        document.querySelector('#extension-notifications button').click(),
      );
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-notifications').hidden,
        ),
        true,
      );
      const requests = [
        {
          id: 'choose',
          kind: 'select',
          title: 'Choose a plan',
          options: ['Read', 'Review'],
          selected: 'Read',
          searchable: true,
        },
        {
          id: 'input',
          kind: 'input',
          title: 'Name the plan',
          placeholder: 'Plan name',
          prefill: 'Initial name',
        },
        {
          id: 'editor',
          kind: 'editor',
          title: 'Edit instructions',
          prefill: 'Initial instructions',
        },
        {
          id: 'confirm',
          kind: 'confirm',
          title: 'Confirm the plan',
          message: 'Continue with this plan?',
        },
        {
          id: 'session-info',
          kind: 'info',
          title: 'Session information',
          message: 'Name: Alpha factory\nMessages: 3\nCost: $0.000000',
        },
      ];
      const values = [
        'Review',
        'Updated name',
        'Edited instructions\nsecond line',
        true,
        true,
      ];
      for (const [index, request] of requests.entries()) {
        hub.sessions[0].ui.dialogs = [request];
        await publish();
        const shown = await evaluate(() => ({
          modal: document.getElementById('extension-dialog').matches(':modal'),
          title: document.getElementById('extension-dialog-title').textContent,
          session: document.getElementById('extension-dialog-session')
            .textContent,
          input: document.getElementById('extension-dialog-input').value,
          editor: document.getElementById('extension-dialog-editor').value,
        }));
        assert.equal(shown.modal, true);
        assert.equal(shown.title, request.title);
        assert.equal(shown.session, 'Alpha factory');
        if (request.prefill) assert.equal(shown[request.kind], request.prefill);
        if (request.selected) {
          assert.equal(
            await evaluate(
              () => document.getElementById('extension-dialog-select').value,
            ),
            request.selected,
          );
          await evaluate(() => {
            const search = document.getElementById('extension-dialog-search');
            search.value = 'no matching model';
            search.dispatchEvent(new Event('input', {bubbles: true}));
          });
          assert.equal(
            await evaluate(
              () => document.getElementById('submit-extension-dialog').disabled,
            ),
            true,
            'An empty search must not submit an unrelated option',
          );
          await evaluate(() => {
            const search = document.getElementById('extension-dialog-search');
            search.value = '';
            search.dispatchEvent(new Event('input', {bubbles: true}));
          });
          assert.equal(
            await evaluate(
              () => document.getElementById('extension-dialog-select').value,
            ),
            request.selected,
            'Clearing the search restores current selection',
          );
        }
        if (request.kind === 'info') {
          assert.deepEqual(
            await evaluate(() => ({
              message: document.getElementById('extension-dialog-message')
                .textContent,
              controlsHidden: ['input', 'select', 'editor', 'search'].every(
                kind =>
                  document.getElementById(`extension-dialog-${kind}`).hidden,
              ),
              submit: document.getElementById('submit-extension-dialog')
                .textContent,
              close: document.getElementById('cancel-extension-dialog')
                .textContent,
            })),
            {
              message: request.message,
              controlsHidden: true,
              submit: 'OK',
              close: 'Close',
            },
          );
        }
        await evaluate(
          (kind, value) => {
            if (!['confirm', 'info'].includes(kind))
              document.getElementById(`extension-dialog-${kind}`).value = value;
            document.getElementById('submit-extension-dialog').click();
          },
          request.kind,
          values[index],
        );
        await until(
          () => !document.getElementById('extension-dialog').open,
          'Extension response did not close the native dialog',
        );
      }
      hub.sessions[0].ui.dialogs = [
        {id: 'cancel', kind: 'input', title: 'Cancel this request'},
      ];
      await publish();
      await press('Escape');
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Escape did not cancel the native extension dialog',
      );
      assert.deepEqual(calls, [
        ...requests.map((request, index) => ({
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: request.id,
          value: values[index],
        })),
        {
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: 'cancel',
          value: undefined,
        },
      ]);

      const loadNotice = {
        id: 'llama-load-notice',
        type: 'info',
        message: 'Model loaded',
      };
      hub.sessions[0].ui = {
        notifications: [loadNotice],
        statuses: [{key: 'llama-load', text: 'Loading model'}],
        editor: {id: 'load-editor', text: 'Earlier draft'},
        dialogs: [
          {
            id: 'llama-load',
            kind: 'custom',
            title: 'llama-load',
            terminal: {
              columns: 80,
              rows: 16,
              output: 'Loading model…\r\n',
              revision: 1,
            },
          },
        ],
      };
      await publish();
      await until(
        () => document.getElementById('extension-dialog').open,
        'The loading dialog did not open',
      );
      hub.sessions[0].ui = {
        notifications: [loadNotice],
        statuses: [{key: 'llama-load', text: 'Ready'}],
        editor: {id: 'ready-editor', text: 'Current draft'},
        dialogs: [],
      };
      await publish();
      await until(
        () => !document.getElementById('extension-dialog').open,
        'The finished loading dialog did not close',
      );
      await clickPointer('#extension-notifications button');
      assert.deepEqual(
        await evaluate(() => ({
          dialogOpen: document.getElementById('extension-dialog').open,
          noticesHidden: document.getElementById('extension-notifications')
            .hidden,
          draft: document.getElementById('parent-prompt').value,
          status: document.getElementById('extension-statuses').textContent,
        })),
        {
          dialogOpen: false,
          noticesHidden: true,
          draft: 'Current draft',
          status: 'llama-load: Ready',
        },
        'Dismissing a notice must keep the latest dialog, status and editor state',
      );
      await clickPointer('#parent-prompt');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'parent-prompt',
        'The composer remains usable after dismissing the loading notice',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('llama-notice-dismissed');
    },
  );

  await run(
    'terminal-backed Pi visualizations keep semantic dialogs keyboard accessible and cancellable',
    async () => {
      const requests = [
        {
          id: 'pi-select',
          kind: 'select',
          title: 'Choose a target',
          options: ['Current branch', 'New branch'],
          selection: 0,
          terminal: {
            columns: 100,
            rows: 28,
            output: terminalMenuOutput(
              'Choose a target',
              ['Current branch', 'New branch'],
              0,
            ),
            revision: 1,
          },
        },
        {
          id: 'pi-confirm',
          kind: 'confirm',
          title: 'Confirm change',
          terminal: {
            columns: 100,
            rows: 28,
            appearance: 'light',
            output: terminalMenuOutput('Confirm change', ['Yes', 'No'], 0),
            revision: 1,
          },
        },
        {
          id: 'pi-input',
          kind: 'input',
          title: 'Name the branch',
          terminal: {
            columns: 100,
            rows: 28,
            output: '\u001bcName the branch\r\n> ',
            revision: 1,
          },
        },
        {
          id: 'pi-editor',
          kind: 'editor',
          title: 'Edit the summary',
          terminal: {
            columns: 100,
            rows: 28,
            output: '\u001bcEdit the summary\r\n\r\nInitial summary',
            revision: 1,
          },
        },
        {
          id: 'pi-info',
          kind: 'info',
          title: 'Branch information',
          terminal: {
            columns: 100,
            rows: 28,
            output:
              '\u001bcBranch information\r\nReady to continue.\r\n\r\nEnter closes',
            revision: 1,
          },
        },
        {
          id: 'pi-fork',
          kind: 'terminal',
          title: 'Fork conversation',
          terminal: {
            columns: 100,
            rows: 45,
            output:
              '\u001bcFork conversation\r\n\r\n' +
              Array.from(
                {length: 38},
                (_, index) =>
                  `${index === 0 ? '> ' : '  '}Message ${index + 1} · ${'long summary '.repeat(5)}`,
              ).join('\r\n'),
            revision: 1,
          },
        },
      ];
      for (const request of requests) {
        hub.sessions[0].ui = {
          dialogs: [request],
          notifications: [],
          statuses: [],
        };
        await publish();
        await until(
          () =>
            document.getElementById('extension-dialog').open &&
            !!document.querySelector('#extension-dialog-terminal .xterm'),
          `${request.kind} terminal visualization did not open`,
        );
        assert.deepEqual(
          await evaluate(() => ({
            terminal: !document.getElementById('extension-dialog-terminal')
              .hidden,
            input: document.getElementById('extension-dialog-input').hidden,
            editor: document.getElementById('extension-dialog-editor').hidden,
            select: document.getElementById('extension-dialog-select').hidden,
            submit: document.getElementById('submit-extension-dialog').hidden,
            session: document.getElementById('extension-dialog-session')
              .textContent,
          })),
          {
            terminal: true,
            input: true,
            editor: true,
            select: true,
            submit: true,
            session: 'Alpha factory',
          },
        );
        if (request.kind === 'confirm') {
          assert.equal(
            await evaluate(
              () =>
                getComputedStyle(
                  document.querySelector(
                    '#extension-dialog-terminal .xterm-viewport',
                  ),
                ).backgroundColor,
            ),
            'rgb(250, 250, 250)',
          );
          if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
            const themes = await evaluate(() =>
              [...document.getElementById('factory-theme').options].map(
                option => option.value,
              ),
            );
            for (const theme of themes) {
              await evaluate(theme => {
                const select = document.getElementById('factory-theme');
                select.value = theme;
                select.dispatchEvent(new Event('change'));
              }, theme);
              await screenshot(`pi-confirm-${theme}`);
            }
            await evaluate(() => {
              const select = document.getElementById('factory-theme');
              select.value = window.fixtureTheme || 'factory';
              select.dispatchEvent(new Event('change'));
            });
          }
          for (const [width, height, zoom] of [
            [900, 760, 1.5],
            [900, 760, 2],
            [1600, 1000, 1],
          ]) {
            window.setContentSize(width, height);
            window.webContents.setZoomFactor(zoom);
            await settle();
            assert.equal(
              await evaluate(() => {
                const dialog = document
                  .getElementById('extension-dialog')
                  .getBoundingClientRect();
                const cancel = document
                  .getElementById('cancel-extension-dialog')
                  .getBoundingClientRect();
                return (
                  dialog.left >= 0 &&
                  dialog.right <= innerWidth &&
                  dialog.top >= 0 &&
                  dialog.bottom <= innerHeight &&
                  cancel.bottom <= dialog.bottom
                );
              }),
              true,
            );
            if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
              await screenshot(`pi-confirm-${width}-${zoom}`);
          }
        }
        if (request.id === 'pi-fork') {
          for (const [width, height, zoom] of [
            [900, 760, 1.5],
            [900, 760, 2],
            [1600, 1000, 1],
          ]) {
            window.setContentSize(width, height);
            window.webContents.setZoomFactor(zoom);
            await settle();
            assert.equal(
              await evaluate(() => {
                const dialog = document
                  .getElementById('extension-dialog')
                  .getBoundingClientRect();
                const terminal = document
                  .getElementById('extension-dialog-terminal')
                  .getBoundingClientRect();
                const cancel = document
                  .getElementById('cancel-extension-dialog')
                  .getBoundingClientRect();
                return (
                  dialog.left >= 0 &&
                  dialog.right <= innerWidth &&
                  dialog.top >= 0 &&
                  dialog.bottom <= innerHeight &&
                  terminal.height > 60 &&
                  cancel.bottom <= dialog.bottom
                );
              }),
              true,
            );
            if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
              await screenshot(`pi-fork-${width}-${zoom}`);
          }
        }
        if (request.kind === 'select') {
          await press('Down');
          await press('Return');
        } else if (['confirm', 'info'].includes(request.kind))
          await press('Return');
        else {
          await press('X');
          await evaluate(() =>
            document.getElementById('cancel-extension-dialog').click(),
          );
        }
        await until(
          () => !document.getElementById('extension-dialog').open,
          `${request.kind} terminal visualization did not settle`,
        );
        const responses = calls.filter(
          call =>
            call.method === 'respondToDialog' && call.dialogId === request.id,
        );
        assert.ok(
          responses.some(
            call =>
              typeof call.value?.input === 'string' || call.value === undefined,
          ),
          `${request.kind} did not use keyboard or cancellation transport`,
        );
      }
    },
  );

  await run(
    'additional agent permission confirmations stay scoped to their workspace through switches errors and cancellation',
    async () => {
      const [alpha, beta] = hub.sessions;
      const worker = (id, name) => ({
        id,
        name,
        cwd: directory,
        model: 'fixture/small',
        thinkingLevel: 'medium',
        task: 'Inspect the project',
        status: 'running',
        activity: 'Waiting for permission',
        resumable: true,
        createdAt: at,
        startedAt: at,
        conversation: [],
      });
      alpha.agents = [worker('permission-worker', 'Permission worker')];
      beta.agents = [
        worker('other-permission-worker', 'Other permission worker'),
      ];
      alpha.totalAgents = beta.totalAgents = 1;
      await publish();
      const chooseWorker = async name => {
        await evaluate(
          name =>
            [...document.querySelectorAll('#active-workers button')]
              .find(
                item =>
                  item.querySelector('.worker-card-name').textContent === name,
              )
              .click(),
          name,
        );
        await settle();
      };
      const chooseWorkspace = async name => {
        await evaluate(
          name =>
            [...document.querySelectorAll('#parents button')]
              .find(
                item =>
                  item.querySelector('.parent-card-name').textContent === name,
              )
              .click(),
          name,
        );
        await settle();
      };
      const confirmation = (id, title) => ({
        id,
        title,
        kind: 'confirm',
        message: 'Allow this configured tool action?',
      });
      const waitDialog = async title => {
        await until(
          () => document.getElementById('extension-dialog').open,
          `Permission confirmation did not open: ${title}`,
        );
        assert.equal(
          await evaluate(
            () => document.getElementById('extension-dialog-title').textContent,
          ),
          title,
        );
      };
      const submit = async () =>
        evaluate(() =>
          document.getElementById('submit-extension-dialog').click(),
        );
      const closed = async () =>
        until(
          () => !document.getElementById('extension-dialog').open,
          'Permission confirmation did not close',
        );
      const editor = async () =>
        evaluate(() => ({
          value: document.getElementById('parent-prompt').value,
          start: document.getElementById('parent-prompt').selectionStart,
          end: document.getElementById('parent-prompt').selectionEnd,
        }));
      await chooseWorker('Permission worker');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Keep this agent draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.setSelectionRange(2, 8);
        editor.dispatchEvent(new Event('select', {bubbles: true}));
      });
      alpha.ui = {
        dialogs: [
          confirmation('permission-confirm', 'Permission worker · Run bash?'),
        ],
        editor: {id: 'workspace-editor', text: 'Main conversation editor text'},
        notifications: [
          {
            id: 'workspace-notice',
            type: 'info',
            message: 'Main conversation notice',
          },
        ],
      };
      await publish();
      await waitDialog('Permission worker · Run bash?');
      assert.deepEqual(await editor(), {
        value: 'Keep this agent draft',
        start: 2,
        end: 8,
      });
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-dialog-session').textContent,
        ),
        'Alpha factory',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-notifications').hidden,
        ),
        true,
      );
      await evaluate(() =>
        document.getElementById('submit-extension-dialog').focus(),
      );
      alpha.agents[0].activity = 'Still waiting for permission';
      await publish();
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'submit-extension-dialog',
      );
      await evaluate(() => document.getElementById('back-to-parent').click());
      assert.equal(
        await evaluate(() => document.getElementById('extension-dialog').open),
        true,
      );
      assert.equal((await editor()).value, 'Main conversation editor text');
      await chooseWorker('Permission worker');
      assert.deepEqual(await editor(), {
        value: 'Keep this agent draft',
        start: 2,
        end: 8,
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('additional-agent-permission-confirm');
      await submit();
      await closed();
      assert.equal(alpha.ui.dialogs.length, 0);
      assert.deepEqual(
        calls.filter(call => call.method === 'respondToDialog'),
        [
          {
            method: 'respondToDialog',
            sessionId: 'alpha',
            dialogId: 'permission-confirm',
            value: true,
          },
        ],
      );

      alpha.ui.dialogs = [
        confirmation('permission-retry', 'Permission worker · Write file?'),
      ];
      dialogErrors.set('alpha', 'Permission confirmation unavailable');
      await publish();
      await waitDialog('Permission worker · Write file?');
      await submit();
      await until(
        () =>
          !document.getElementById('extension-dialog-error').hidden &&
          !document.getElementById('submit-extension-dialog').disabled,
        'Permission error did not allow retry',
      );
      assert.match(
        await evaluate(
          () => document.getElementById('extension-dialog-error').textContent,
        ),
        /Permission confirmation unavailable/,
      );
      assert.equal(alpha.ui.dialogs.length, 1);
      dialogErrors.delete('alpha');
      await submit();
      await closed();

      alpha.ui.dialogs = [
        confirmation('permission-cancel', 'Permission worker · Delete file?'),
      ];
      await publish();
      await waitDialog('Permission worker · Delete file?');
      await press('Escape');
      await closed();
      assert.deepEqual(
        calls.filter(call => call.method === 'respondToDialog').at(-1),
        {
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: 'permission-cancel',
          value: undefined,
        },
      );

      for (const failure of [undefined, 'Late failure from Alpha']) {
        alpha.ui.dialogs = [
          confirmation(
            'shared-permission',
            'Permission worker · Allow command?',
          ),
        ];
        beta.ui = {
          dialogs: [
            confirmation(
              'shared-permission',
              'Other permission worker · Allow command?',
            ),
          ],
        };
        dialogDelays.set('alpha', 160);
        if (failure) dialogErrors.set('alpha', failure);
        await publish();
        await waitDialog('Permission worker · Allow command?');
        await submit();
        assert.equal(
          await evaluate(
            () => document.getElementById('submit-extension-dialog').disabled,
          ),
          true,
        );
        await chooseWorkspace('Beta factory');
        await chooseWorker('Other permission worker');
        await waitDialog('Other permission worker · Allow command?');
        await new Promise(resolve => setTimeout(resolve, 220));
        assert.deepEqual(
          await evaluate(() => ({
            open: document.getElementById('extension-dialog').open,
            errorHidden: document.getElementById('extension-dialog-error')
              .hidden,
            disabled: document.getElementById('submit-extension-dialog')
              .disabled,
            workspace: document.getElementById('extension-dialog-session')
              .textContent,
          })),
          {
            open: true,
            errorHidden: true,
            disabled: false,
            workspace: 'Beta factory',
          },
        );
        await submit();
        await closed();
        assert.equal(beta.ui.dialogs.length, 0);
        assert.equal(alpha.ui.dialogs.length, failure ? 1 : 0);
        dialogDelays.delete('alpha');
        dialogErrors.delete('alpha');
        await chooseWorkspace('Alpha factory');
        await chooseWorker('Permission worker');
        if (failure) {
          await waitDialog('Permission worker · Allow command?');
          await press('Escape');
          await closed();
        }
      }

      alpha.ui.dialogs = [
        confirmation(
          'permission-aborted',
          'Permission worker · Permission cancelled by Stop',
        ),
      ];
      await publish();
      await waitDialog('Permission worker · Permission cancelled by Stop');
      alpha.ui.dialogs = [];
      alpha.agents[0].status = 'cancelled';
      await publish();
      await closed();
      assert.deepEqual(await editor(), {
        value: 'Keep this agent draft',
        start: 2,
        end: 8,
      });
      assert.equal(
        calls.some(
          call =>
            call.method === 'abort' ||
            (call.method === 'agentSession' && call.request.action === 'abort'),
        ),
        false,
      );
      assert.deepEqual(
        calls
          .filter(call => call.method === 'respondToDialog')
          .map(call => [call.sessionId, call.dialogId, call.value]),
        [
          ['alpha', 'permission-confirm', true],
          ['alpha', 'permission-retry', true],
          ['alpha', 'permission-retry', true],
          ['alpha', 'permission-cancel', undefined],
          ['alpha', 'shared-permission', true],
          ['beta', 'shared-permission', true],
          ['alpha', 'shared-permission', true],
          ['beta', 'shared-permission', true],
          ['alpha', 'shared-permission', undefined],
        ],
      );
    },
  );

  await run(
    'terminal extension dialog renders ANSI and forwards input and viewport size before Cancel',
    async () => {
      await evaluate(() => {
        const Terminal = window.Terminal;
        if (!Terminal) throw new Error('Local xterm asset did not load');
        window.Terminal = class extends Terminal {
          constructor(options) {
            super(options);
            window.fixtureTerminal = this;
          }
        };
      });
      hub.sessions[0].ui = {
        dialogs: [
          {
            id: 'terminal-1',
            kind: 'terminal',
            title: 'Fixture terminal',
            terminal: {
              columns: 40,
              rows: 6,
              output:
                '\u001b[31mANSI ready\u001b[0m\r\n' +
                Array.from(
                  {length: 60},
                  (_, index) => `Scrollable line ${index + 1}`,
                ).join('\r\n') +
                '\r\nInput: ',
              revision: 1,
            },
          },
        ],
        notifications: [],
        statuses: [],
      };
      await publish();
      await until(
        () =>
          window.fixtureTerminal?.buffer.active
            .getLine(0)
            ?.translateToString(true) === 'ANSI ready',
        'xterm did not render the ANSI frame',
      );
      await until(
        () => window.fixtureTerminal?.buffer.active.length >= 50,
        'xterm did not finish rendering scrollable output',
      );
      const rendered = await evaluate(() => ({
        modal: document.getElementById('extension-dialog').matches(':modal'),
        widget: !!document.querySelector('#extension-dialog-terminal .xterm'),
        input: !!document.querySelector('#extension-dialog-terminal textarea'),
        foreground: window.fixtureTerminal.buffer.active
          .getLine(0)
          .getCell(0)
          .getFgColor(),
        columns: window.fixtureTerminal.cols,
        rows: window.fixtureTerminal.rows,
        scrolls: window.fixtureTerminal.buffer.active.baseY > 0,
        dialogFits:
          document.getElementById('extension-dialog').getBoundingClientRect()
            .bottom <= innerHeight,
        footerVisible:
          document
            .getElementById('cancel-extension-dialog')
            .getBoundingClientRect().bottom <= innerHeight,
      }));
      assert.deepEqual(
        {
          modal: rendered.modal,
          widget: rendered.widget,
          input: rendered.input,
          foreground: rendered.foreground,
          scrolls: rendered.scrolls,
          dialogFits: rendered.dialogFits,
          footerVisible: rendered.footerVisible,
        },
        {
          modal: true,
          widget: true,
          input: true,
          foreground: 1,
          scrolls: true,
          dialogFits: true,
          footerVisible: true,
        },
      );
      assert.ok(rendered.columns >= 20 && rendered.columns <= 240);
      assert.ok(rendered.rows >= 6 && rendered.rows <= 100);
      await press('Return');
      await until(
        () =>
          Array.from(
            {length: window.fixtureTerminal.buffer.active.length},
            (_, index) =>
              window.fixtureTerminal.buffer.active
                .getLine(index)
                ?.translateToString(true) || '',
          ).some(line => line.includes('Received')),
        'Terminal response frame did not render',
      );
      assert.deepEqual(
        calls.filter(call => typeof call.value?.input === 'string').at(-1),
        {
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: 'terminal-1',
          value: {input: '\r'},
        },
      );
      assert.deepEqual(
        calls.filter(call => Number.isInteger(call.value?.columns)).at(-1)
          .value,
        {columns: rendered.columns, rows: rendered.rows},
      );
      await press('Escape');
      assert.deepEqual(
        calls.filter(call => typeof call.value?.input === 'string').at(-1),
        {
          method: 'respondToDialog',
          sessionId: 'alpha',
          dialogId: 'terminal-1',
          value: {input: '\u001b'},
        },
      );
      assert.equal(
        await evaluate(() => document.getElementById('extension-dialog').open),
        true,
        'Escape must remain inside the terminal dialog',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('terminal-1600x1000');
      await evaluate(() =>
        document.getElementById('cancel-extension-dialog').click(),
      );
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Cancel did not close the terminal dialog',
      );
      assert.deepEqual(calls.filter(call => call.value === undefined).at(-1), {
        method: 'respondToDialog',
        sessionId: 'alpha',
        dialogId: 'terminal-1',
        value: undefined,
      });
    },
  );

  await run(
    'custom extension editor sends the full draft and returns a focused saved composer draft',
    async () => {
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-editor').hidden,
        ),
        true,
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Alpha unchanged draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click();
      });
      await settle();
      hub.sessions[1].ui = {
        extensionEditor: {id: 'beta-editor-open'},
        dialogs: [],
        notifications: [],
        statuses: [],
      };
      await publish();
      assert.equal(
        await evaluate(() => {
          const button = document.getElementById('extension-editor');
          return !button.hidden && button.getClientRects().length > 0;
        }),
        true,
      );
      const originalDraft =
        'Full draft to the custom editor\n' +
        'Keep every line, symbol and instruction: äö ✓.\n'.repeat(12) +
        'FINAL DRAFT LINE';
      const returnedDraft =
        'Edited draft returned by the extension\nSecond line ✓';
      editorSubmission = returnedDraft;
      await evaluate(value => {
        const editor = document.getElementById('parent-prompt');
        editor.value = value;
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('extension-editor').click();
      }, originalDraft);
      await until(
        () =>
          document.getElementById('extension-dialog').matches(':modal') &&
          !!document.querySelector('#extension-dialog-terminal .xterm'),
        'Custom editor did not open its terminal dialog',
      );
      assert.deepEqual(calls[0], {
        method: 'respondToDialog',
        sessionId: 'beta',
        dialogId: 'beta-editor-open',
        value: originalDraft,
      });
      await press('Return');
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Submitted custom editor did not close its terminal dialog',
      );
      assert.deepEqual(
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          return {
            value: editor.value,
            focused: document.activeElement === editor,
            start: editor.selectionStart,
            end: editor.selectionEnd,
          };
        }),
        {
          value: returnedDraft,
          focused: true,
          start: returnedDraft.length,
          end: returnedDraft.length,
        },
      );
      await evaluate(() => document.getElementById('extension-editor').click());
      await until(
        () => document.getElementById('extension-dialog').matches(':modal'),
        'Custom editor could not reopen for cancellation',
      );
      await evaluate(() =>
        document.getElementById('cancel-extension-dialog').click(),
      );
      await until(
        () => !document.getElementById('extension-dialog').open,
        'Canceled custom editor did not close',
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        returnedDraft,
        'Canceling a custom editor must preserve the existing draft',
      );
      delete hub.sessions[1].ui.extensionEditor;
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('extension-editor').hidden,
        ),
        true,
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Alpha factory'))
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Alpha unchanged draft',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        returnedDraft,
        'The returned custom editor text must be saved as Beta’s draft',
      );
      assert.deepEqual(
        calls.filter(call => !Number.isInteger(call.value?.columns)),
        [
          {
            method: 'respondToDialog',
            sessionId: 'beta',
            dialogId: 'beta-editor-open',
            value: originalDraft,
          },
          {
            method: 'respondToDialog',
            sessionId: 'beta',
            dialogId: 'custom-editor-terminal',
            value: {input: '\r'},
          },
          {
            method: 'respondToDialog',
            sessionId: 'beta',
            dialogId: 'beta-editor-open',
            value: returnedDraft,
          },
          {
            method: 'respondToDialog',
            sessionId: 'beta',
            dialogId: 'custom-editor-terminal',
            value: undefined,
          },
        ],
      );
    },
  );

  await run(
    'direct agent prompts resume retained conversations and isolate drafts cursor pending sends and errors',
    async () => {
      await until(
        () =>
          document.querySelectorAll('#scene-labels .scene-label').length === 1,
        'A workspace with one agent must show only its main robot',
      );
      assert.deepEqual(
        await evaluate(() => ({
          labels: [
            ...document.querySelectorAll('#scene-labels .scene-label'),
          ].map(label => ({
            main: label.classList.contains('parent-label'),
            selected: label.getAttribute('aria-pressed'),
            name: label.textContent,
          })),
          workspaces: document.querySelectorAll('#parents .parent-card').length,
          counts: document.getElementById('hub-counts').textContent,
        })),
        {
          labels: [{main: true, selected: 'true', name: 'Alpha factory'}],
          workspaces: 2,
          counts: '2 workspaces · 2 working agents',
        },
      );
      const owner = hub.sessions[0];
      owner.agents = ['one', 'two', 'disposed'].map((id, index) => ({
        id,
        name: `Promptable ${id}`,
        cwd: `${directory}/${id}`,
        task: `Task ${id}`,
        status: index === 1 ? 'failed' : 'cancelled',
        resumable: id !== 'disposed',
        autoCleanup: false,
        model: 'fixture/small',
        thinkingLevel: 'medium',
        createdAt: at,
        startedAt: at,
        conversation: [],
      }));
      owner.totalAgents = owner.agents.length;
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#parents .parent-card').length,
        ),
        2,
      );
      const choose = async name => {
        await evaluate(
          name =>
            [
              ...document.querySelectorAll(
                '#parents button, #active-workers button, #history-workers button',
              ),
            ]
              .find(
                item =>
                  item.querySelector(
                    '.parent-card-name, .worker-card-name, .history-row-name',
                  )?.textContent === name,
              )
              .click(),
          name,
        );
        await settle();
      };
      const draft = async (value, start, end) =>
        evaluate(
          (value, start, end) => {
            const editor = document.getElementById('parent-prompt');
            editor.value = value;
            editor.dispatchEvent(new Event('input', {bubbles: true}));
            editor.focus();
            editor.setSelectionRange(start, end, 'backward');
            editor.dispatchEvent(new Event('select', {bubbles: true}));
          },
          value,
          start,
          end,
        );
      const editorState = () =>
        evaluate(() => ({
          value: document.getElementById('parent-prompt').value,
          start: document.getElementById('parent-prompt').selectionStart,
          end: document.getElementById('parent-prompt').selectionEnd,
          direction:
            document.getElementById('parent-prompt').selectionDirection,
          sending: document.getElementById('send-prompt').disabled,
          error: document.getElementById('prompt-error').hidden
            ? null
            : document.getElementById('prompt-error').textContent,
        }));
      await draft('Original root draft', 3, 9);
      await choose('Promptable one');
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '#parents [aria-pressed="true"] .parent-card-name',
            ).textContent,
        ),
        'Alpha factory',
      );
      await draft('First agent draft', 2, 7);
      await choose('Promptable two');
      await draft('Second agent draft', 1, 8);
      await choose('Promptable one');
      assert.deepEqual(await editorState(), {
        value: 'First agent draft',
        start: 2,
        end: 7,
        direction: 'backward',
        sending: false,
        error: null,
      });
      agentPromptError = 'Agent provider unavailable';
      agentPromptDelay = 180;
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      assert.equal((await editorState()).sending, true);
      await choose('Promptable two');
      assert.equal((await editorState()).sending, false);
      await new Promise(resolve => setTimeout(resolve, 220));
      assert.equal((await editorState()).error, null);
      await choose('Promptable one');
      assert.match((await editorState()).error, /Agent provider unavailable/);
      assert.equal((await editorState()).value, 'First agent draft');
      agentPromptError = undefined;
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      await choose('Promptable two');
      await new Promise(resolve => setTimeout(resolve, 220));
      assert.equal((await editorState()).value, 'Second agent draft');
      await choose('Promptable one');
      assert.equal((await editorState()).value, '');
      assert.equal(owner.agents[0].status, 'running');
      await draft('Steer the first agent', 0, 0);
      assert.equal(
        await evaluate(
          () => document.getElementById('send-prompt').textContent,
        ),
        'Steer',
      );
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Direct steering was not acknowledged',
      );
      assert.deepEqual(owner.agents[0].queue.steering, [
        'Steer the first agent',
      ]);
      await choose('Promptable two');
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Failed retained agent did not resume',
      );
      assert.equal(owner.agents[1].status, 'running');
      await draft('Draft survives reload', 4, 11);
      await choose('Alpha factory');
      assert.deepEqual(await editorState(), {
        value: 'Original root draft',
        start: 3,
        end: 9,
        direction: 'backward',
        sending: false,
        error: null,
      });
      await reloadPage();
      await choose('Promptable two');
      assert.deepEqual(await editorState(), {
        value: 'Draft survives reload',
        start: 4,
        end: 11,
        direction: 'backward',
        sending: false,
        error: null,
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await screenshot('direct-agent-composer');
        window.setContentSize(1100, 760);
        await settle();
        await screenshot('direct-agent-composer-compact');
        window.webContents.setZoomFactor(1.5);
        await settle();
        await screenshot('direct-agent-composer-compact-zoom');
        window.webContents.setZoomFactor(1);
        window.setContentSize(1600, 1000);
        await settle();
      }
      await choose('Promptable disposed');
      assert.equal(
        await evaluate(() => document.getElementById('parent-controls').hidden),
        true,
      );
      assert.equal(calls.filter(call => call.method === 'prompt').length, 0);
      assert.equal(owner.session.status, 'running');
      assert.deepEqual(owner.queue, {steering: [], followUp: []});

      owner.agents.push({
        id: 'delegated',
        name: 'Delegated only',
        cwd: `${directory}/delegated`,
        task: 'Task delegated',
        status: 'running',
        resumable: true,
        agentMode: 'subagent',
        autoCleanup: false,
        model: 'fixture/small',
        thinkingLevel: 'medium',
        createdAt: at,
        startedAt: at,
        conversation: [],
      });
      owner.totalAgents = owner.agents.length;
      agentPromptDelay = 0;
      await publish();
      await choose('Delegated only');
      assert.deepEqual(
        await evaluate(() => ({
          composerHidden: document.getElementById('parent-controls').hidden,
          sendDisabled: document.getElementById('send-prompt').disabled,
          taskDockHidden: document.getElementById('agent-task-dock').hidden,
          task: document.getElementById('agent-task-text').textContent,
          cancelHidden: document.getElementById('cancel-agent').hidden,
          cancelDisabled: document.getElementById('cancel-agent').disabled,
          detailsHidden: document.getElementById('tab-details').hidden,
          contextHidden: document.getElementById('tab-context').hidden,
        })),
        {
          composerHidden: true,
          sendDisabled: true,
          taskDockHidden: false,
          task: 'Task delegated',
          cancelHidden: false,
          cancelDisabled: false,
          detailsHidden: false,
          contextHidden: false,
        },
        'Subagent workers retain task, stop, details, and context controls',
      );
      await evaluate(() => document.getElementById('tab-details').click());
      assert.equal(
        await evaluate(() => document.getElementById('panel-details').hidden),
        false,
      );
      await evaluate(() => document.getElementById('tab-context').click());
      assert.equal(
        await evaluate(() => document.getElementById('panel-context').hidden),
        false,
      );
      await evaluate(() => document.getElementById('tab-conversation').click());
      const directPrompts = calls.filter(
        call =>
          call.method === 'agentSession' && call.request.action === 'prompt',
      ).length;
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Prompt delegated worker directly';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settle();
      assert.equal(
        calls.filter(
          call =>
            call.method === 'agentSession' && call.request.action === 'prompt',
        ).length,
        directPrompts,
        'Enter must not send a direct prompt to a subagent worker',
      );
      assert.deepEqual(
        await evaluate(() => ({
          composerHidden: document.getElementById('parent-controls').hidden,
          draft: document.getElementById('parent-prompt').value,
        })),
        {
          composerHidden: true,
          draft: 'Prompt delegated worker directly',
        },
      );
      assert.deepEqual(
        calls
          .filter(
            call =>
              call.method === 'agentSession' &&
              call.request.action === 'prompt',
          )
          .map(call => [
            call.sessionId,
            call.request.agentId,
            call.request.prompt,
          ]),
        [
          ['alpha', 'one', 'First agent draft'],
          ['alpha', 'one', 'First agent draft'],
          ['alpha', 'one', 'Steer the first agent'],
          ['alpha', 'two', 'Second agent draft'],
        ],
      );
    },
  );

  await run(
    'agent conversations isolate messages, tools, disclosures and drafts and switch to bottom',
    async () => {
      const parent = hub.sessions[0];
      parent.conversation[2].id = 'shared-tool';
      const agent = (id, name, agentMode) => ({
        id,
        name,
        ...(agentMode ? {agentMode} : {}),
        cwd: directory,
        model: 'fixture/small',
        task: `Task for ${name}`,
        status: 'running',
        activity: `Working on ${name}`,
        createdAt: at,
        startedAt: at,
        conversationTruncated: false,
        sessionFile: `/fixture/${id}.jsonl`,
        conversation: [
          {id: 'shared-user', role: 'user', at, text: `Task for ${name}`},
          {
            id: 'shared-answer',
            role: 'assistant',
            at,
            text: `${name} answer`,
            streaming: true,
          },
          {
            id: 'shared-tool',
            role: 'tool',
            toolName: 'bash',
            at,
            status: 'running',
            streaming: true,
            input: JSON.stringify({command: `printf '${name}\\n'\npwd`}),
            text: `${name} output\n`,
          },
        ],
      });
      parent.agents = [
        agent('agent-one', 'First agent', 'primary'),
        agent('agent-two', 'Second agent', 'all'),
        agent('agent-subagent', 'Delegated agent', 'subagent'),
        agent('agent-legacy', 'Legacy agent'),
      ];
      parent.totalAgents = parent.agents.length;
      parent.queue.steering = ['Parent steering'];
      parent.ui = {
        notifications: [{id: 'notice', type: 'info', message: 'Parent notice'}],
        statuses: [{key: 'parent', text: 'Parent status'}],
      };
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          selected: (() => {
            const glyph = document.getElementById('selected-conversation-mark');
            const crown = glyph.querySelector('.robot-crown');
            return {
              kind: glyph.dataset.agentKind,
              main: glyph.classList.contains('robot-main'),
              primary: glyph.classList.contains('robot-primary'),
              subagent: glyph.classList.contains('robot-subagent'),
              crown: getComputedStyle(crown).display !== 'none',
              crownHidden: crown.getAttribute('aria-hidden'),
              role: glyph.getAttribute('role'),
              label: glyph.getAttribute('aria-label'),
            };
          })(),
          parents: [...document.querySelectorAll('#parents .parent-card')].map(
            card => {
              const glyph = card.querySelector('.robot-glyph');
              return {
                kind: glyph.dataset.agentKind,
                main: glyph.classList.contains('robot-main'),
                crown:
                  getComputedStyle(glyph.querySelector('.robot-crown'))
                    .display !== 'none',
                role: glyph.getAttribute('role'),
                label: glyph.getAttribute('aria-label'),
              };
            },
          ),
          subagentSmaller: (() => {
            const main = document
              .querySelector('#parents .robot-main')
              .getBoundingClientRect();
            const primary = document
              .querySelector('#active-workers .robot-primary')
              .getBoundingClientRect();
            const subagent = document
              .querySelector('#active-workers .robot-subagent')
              .getBoundingClientRect();
            return (
              subagent.width < primary.width &&
              subagent.height < primary.height &&
              subagent.width < main.width &&
              subagent.height < main.height
            );
          })(),
          workers: Object.fromEntries(
            [...document.querySelectorAll('#active-workers .worker-card')].map(
              card => {
                const name =
                  card.querySelector('.worker-card-name').textContent;
                const glyph = card.querySelector('.robot-glyph');
                return [
                  name,
                  {
                    kind: card.dataset.agentKind,
                    glyphKind: glyph.dataset.agentKind,
                    primary: glyph.classList.contains('robot-primary'),
                    subagent: glyph.classList.contains('robot-subagent'),
                    crown:
                      getComputedStyle(glyph.querySelector('.robot-crown'))
                        .display !== 'none',
                    role: glyph.getAttribute('role'),
                    label: glyph.getAttribute('aria-label'),
                  },
                ];
              },
            ),
          ),
        })),
        {
          selected: {
            kind: 'main',
            main: true,
            primary: false,
            subagent: false,
            crown: false,
            crownHidden: 'true',
            role: 'img',
            label: 'Main agent',
          },
          parents: [
            {
              kind: 'main',
              main: true,
              crown: false,
              role: 'img',
              label: 'Main agent',
            },
            {
              kind: 'main',
              main: true,
              crown: false,
              role: 'img',
              label: 'Main agent',
            },
          ],
          subagentSmaller: true,
          workers: {
            'First agent': {
              kind: 'primary',
              glyphKind: 'primary',
              primary: true,
              subagent: false,
              crown: true,
              role: 'img',
              label: 'Primary agent',
            },
            'Second agent': {
              kind: 'primary',
              glyphKind: 'primary',
              primary: true,
              subagent: false,
              crown: true,
              role: 'img',
              label: 'Primary agent',
            },
            'Delegated agent': {
              kind: 'subagent',
              glyphKind: 'subagent',
              primary: false,
              subagent: true,
              crown: false,
              role: 'img',
              label: 'Subagent',
            },
            'Legacy agent': {
              kind: 'primary',
              glyphKind: 'primary',
              primary: true,
              subagent: false,
              crown: true,
              role: 'img',
              label: 'Primary agent',
            },
          },
        },
        'Workspace and worker cards show their agent type markers',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Unsent parent draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.querySelector('#conversation details summary').click();
        document.querySelector('#active-workers button').click();
        document.querySelector('#conversation details').open = true;
      });
      await settle();
      assert.deepEqual(
        await evaluate(() => ({
          title: document.getElementById('inspector-title').textContent,
          kind: document.getElementById('inspector').dataset.conversationKind,
          kindLabel: document.getElementById('conversation-kind-label')
            .textContent,
          selectedMark: (() => {
            const glyph = document.getElementById('selected-conversation-mark');
            return {
              kind: glyph.dataset.agentKind,
              primary: glyph.classList.contains('robot-primary'),
              crown:
                getComputedStyle(glyph.querySelector('.robot-crown'))
                  .display !== 'none',
              label: glyph.getAttribute('aria-label'),
            };
          })(),
          recipient: document.getElementById('conversation-recipient')
            .textContent,
          messages: [
            ...document.querySelectorAll('#conversation .conversation-text'),
          ].map(item => item.textContent),
          tool: document.querySelector('#conversation .tool-output')
            .textContent,
          input: document.querySelector('#conversation .tool-input')
            .textContent,
          open: document.querySelector('#conversation details').open,
          composer: document.getElementById('parent-controls').hidden,
          settings: document.getElementById('open-session-settings').hidden,
          context: document.getElementById('tab-context').hidden,
          steering: document.getElementById('steering-messages').hidden,
          notifications: document.getElementById('extension-notifications')
            .hidden,
          statuses: document.getElementById('extension-statuses').hidden,
          back: document.getElementById('back-to-parent').textContent.trim(),
          activity: document.getElementById('conversation-activity-text')
            .textContent,
        })),
        {
          title: 'First agent',
          kind: 'primary',
          kindLabel: 'Primary agent',
          selectedMark: {
            kind: 'primary',
            primary: true,
            crown: true,
            label: 'Primary agent',
          },
          recipient: 'Agent · First agent',
          messages: ['Task for First agent', 'First agent answer'],
          tool: 'First agent output\n',
          input: "Run command\n\nCommand:\nprintf 'First agent\\n'\npwd",
          open: true,
          composer: false,
          settings: false,
          context: false,
          steering: true,
          notifications: true,
          statuses: true,
          back: 'Back',
          activity: 'Working on First agent',
        },
      );
      parent.agents[0].conversation[1].text += '\nAgent progress line'.repeat(
        60,
      );
      await publish();
      await evaluate(() => {
        document.getElementById('panel-conversation').scrollTop = 180;
        document
          .getElementById('panel-conversation')
          .dispatchEvent(new Event('scroll'));
        const text = document.querySelector(
          '#conversation .tool-output',
        ).firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 11);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.fixtureAgent = {
          text,
          row: document.querySelector('#conversation .conversation-tool'),
        };
        document.getElementById('follow-conversation').checked = false;
        document
          .getElementById('follow-conversation')
          .dispatchEvent(new Event('change'));
      });
      // Extension edits belong to the parent and must wait until its view is opened.
      parent.ui.editor = {id: 'parent-editor', text: 'Returned parent draft'};
      parent.agents[0].conversation[2].input = JSON.stringify({
        command: "printf 'First agent\\n'\npwd\ngit status",
      });
      parent.agents[0].conversation[2].text += 'More streamed output';
      parent.conversation[2].text = 'Parent changed output';
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          selection: window.getSelection().toString(),
          text:
            document.querySelector('#conversation .tool-output').firstChild ===
            window.fixtureAgent.text,
          row:
            document.querySelector('#conversation .conversation-tool') ===
            window.fixtureAgent.row,
          output: document.querySelector('#conversation .tool-output')
            .textContent,
          input: document.querySelector('#conversation .tool-input')
            .textContent,
          draft: document.getElementById('parent-prompt').value,
        })),
        {
          selection: 'First agent',
          text: true,
          row: true,
          output: 'First agent output\nMore streamed output',
          input:
            "Run command\n\nCommand:\nprintf 'First agent\\n'\npwd\ngit status",
          draft: '',
        },
      );
      await evaluate(() => {
        document.getElementById('parent-prompt').dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
        document.getElementById('prompt-form').requestSubmit();
        document.dispatchEvent(
          new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}),
        );
        document.getElementById('open-commands').click();
        document.querySelector('#conversation details summary').click();
        [...document.querySelectorAll('#active-workers button')]
          .find(button => button.textContent.includes('Second agent'))
          .click();
      });
      await settle();
      assert.deepEqual(
        calls.filter(call => call.method !== 'agentSession'),
        [],
        'Agent view shortcuts cannot act on another conversation',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .tool-output').textContent,
        ),
        'Second agent output\n',
      );
      assert.equal(
        await evaluate(
          () => document.querySelector('#conversation details').open,
        ),
        false,
      );
      // Factory robot selections also open the agent conversation.
      await evaluate(() =>
        [...document.querySelectorAll('.scene-label, #fallback-units button')]
          .find(item => item.textContent.includes('First agent'))
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(
          () => document.getElementById('inspector-title').textContent,
        ),
        'First agent',
      );
      assert.equal(
        await evaluate(
          () => document.querySelector('#conversation details').open,
        ),
        false,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('follow-conversation').checked,
        ),
        true,
      );
      assert.ok(
        await evaluate(() => {
          const panel = document.getElementById('panel-conversation');
          return panel.scrollHeight - panel.clientHeight - panel.scrollTop < 4;
        }),
        'Returning to an agent must show its latest content',
      );
      parent.agents[0].status = 'failed';
      parent.agents[0].conversation[2].status = 'failed';
      parent.agents[0].conversation[2].text = JSON.stringify({
        stdout: 'Agent output\nDetails',
        stderr: 'Agent execution failed\nCheck command',
        exitCode: 1,
      });
      parent.agents[0].conversation[2].error =
        'Agent execution failed\nCheck command';
      parent.agents[0].conversation[2].streaming = false;
      await publish();
      assert.equal(
        await evaluate(
          () =>
            document.querySelector(
              '#conversation .conversation-error:not([hidden])',
            ).textContent,
        ),
        'Agent execution failed\nCheck command',
      );
      assert.match(
        await evaluate(
          () =>
            document.querySelector('#conversation .tool-output').textContent,
        ),
        /Standard output:\nAgent output\nDetails/,
      );
      assert.deepEqual(
        await evaluate(() => {
          const row = [...document.querySelectorAll('.history-row')].find(
            item => item.textContent.includes('First agent'),
          );
          const glyph = row.querySelector('.robot-glyph');
          return {
            rowKind: row.dataset.agentKind,
            glyphKind: glyph.dataset.agentKind,
            crown:
              getComputedStyle(glyph.querySelector('.robot-crown')).display !==
              'none',
            label: glyph.getAttribute('aria-label'),
          };
        }),
        {
          rowKind: 'primary',
          glyphKind: 'primary',
          crown: true,
          label: 'Primary agent',
        },
        'Primary agent history rows retain their crown marker',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() => {
          document.querySelector('#conversation details summary').click();
          document.getElementById('panel-conversation').scrollTop =
            document.getElementById('panel-conversation').scrollHeight;
        });
        await screenshot('agent-conversation');
      }
      // Restore the original local draft when there is no queued editor update.
      delete parent.ui.editor;
      await publish();
      await evaluate(() => document.getElementById('back-to-parent').click());
      assert.deepEqual(
        await evaluate(() => ({
          title: document.getElementById('inspector-title').textContent,
          draft: document.getElementById('parent-prompt').value,
          tool: document.querySelector('#conversation .tool-output')
            .textContent,
          open: document.querySelector('#conversation details').open,
          composer: document.getElementById('parent-controls').hidden,
          context: document.getElementById('tab-context').hidden,
          follow: document.getElementById('follow-conversation').checked,
        })),
        {
          title: 'Alpha factory',
          draft: 'Unsent parent draft',
          tool: 'Parent changed output',
          open: true,
          composer: false,
          context: false,
          follow: true,
        },
      );
      parent.agents[1].name =
        'Second agent with a long name that stays within the header';
      hub.sessions[1].session.name =
        'Beta factory with a long parent session name that stays within the header';
      hub.sessions[1].queue.steering = [...parent.queue.steering];
      await publish();
      for (const [width, height] of [
        [1100, 760],
        [1600, 1000],
      ]) {
        window.setContentSize(width, height);
        await settle();
        await settle();
        const geometry = async () =>
          evaluate(() =>
            Object.fromEntries(
              [
                '#inspector',
                '.inspector-heading',
                '.conversation-kind',
                '.inspector-tabs',
                '#panel-conversation',
                '#composer-slot',
                '#scene',
                '#active-workers button',
              ].map(selector => {
                const box = document
                  .querySelector(selector)
                  .getBoundingClientRect();
                return [
                  selector,
                  {x: box.x, y: box.y, width: box.width, height: box.height},
                ];
              }),
            ),
          );
        const inspectKind = async () =>
          evaluate(() => {
            const inspector = document.getElementById('inspector');
            const label = document.getElementById('conversation-kind-label');
            const range = document.createRange();
            range.selectNodeContents(label);
            const textBounds = range.getBoundingClientRect();
            const slotBounds = label.parentElement.getBoundingClientRect();
            return {
              kind: inspector.dataset.conversationKind,
              marker:
                document.querySelector('.conversation-kind').dataset.agentKind,
              label: label.textContent,
              title: document.getElementById('inspector-title').textContent,
              titleHint: document.getElementById('inspector-title').title,
              complete: textBounds.right <= slotBounds.right + 1,
              background: getComputedStyle(
                document.querySelector('.inspector-heading'),
              ).backgroundImage,
              mainIcon:
                getComputedStyle(document.querySelector('.kind-main-icon'))
                  .display !== 'none',
              primaryIcon:
                getComputedStyle(document.querySelector('.kind-primary-icon'))
                  .display !== 'none',
              subagentIcon:
                getComputedStyle(document.querySelector('.kind-subagent-icon'))
                  .display !== 'none',
            };
          });
        const parentKind = await inspectKind();
        assert.equal(parentKind.label, 'Main agent');
        assert.equal(parentKind.kind, 'main');
        assert.equal(parentKind.marker, 'main');
        assert.equal(parentKind.title, 'Alpha factory');
        assert.equal(
          parentKind.complete,
          true,
          'Parent session label should be fully visible',
        );
        assert.equal(parentKind.mainIcon, true);
        assert.equal(parentKind.primaryIcon, false);
        assert.equal(parentKind.subagentIcon, false);
        const parentBounds = await geometry();
        await evaluate(() =>
          [...document.querySelectorAll('#parents button')]
            .find(button => button.textContent.includes('Beta factory'))
            .click(),
        );
        await settle();
        const otherParentBounds = await evaluate(() =>
          Object.fromEntries(
            [
              '#inspector',
              '.inspector-heading',
              '.inspector-tabs',
              '#panel-conversation',
              '#composer-slot',
              '#scene',
            ].map(selector => {
              const box = document
                .querySelector(selector)
                .getBoundingClientRect();
              return [
                selector,
                {x: box.x, y: box.y, width: box.width, height: box.height},
              ];
            }),
          ),
        );
        for (const selector of Object.keys(otherParentBounds))
          assert.deepEqual(
            otherParentBounds[selector],
            parentBounds[selector],
            `Parent switch moved ${selector} at ${width}`,
          );
        await evaluate(() =>
          [...document.querySelectorAll('#parents button')]
            .find(button => button.textContent.includes('Alpha factory'))
            .click(),
        );
        await settle();
        await evaluate(() =>
          [
            ...document.querySelectorAll(
              '#active-workers button, #history-workers button',
            ),
          ]
            .find(button => button.textContent.includes('Second agent'))
            .click(),
        );
        await settle();
        const agentBounds = await geometry();
        const agentKind = await inspectKind();
        assert.equal(agentKind.label, 'Primary agent');
        assert.equal(agentKind.kind, 'primary');
        assert.equal(agentKind.marker, 'primary');
        assert.equal(agentKind.title, parent.agents[1].name);
        assert.equal(agentKind.titleHint, parent.agents[1].name);
        assert.equal(
          agentKind.complete,
          true,
          'Agent conversation label should be fully visible',
        );
        assert.equal(agentKind.mainIcon, false);
        assert.equal(agentKind.primaryIcon, true);
        assert.equal(agentKind.subagentIcon, false);
        assert.notEqual(
          agentKind.background,
          parentKind.background,
          'Main and primary conversations use distinct heading accents',
        );
        for (const selector of Object.keys(parentBounds).filter(
          selector =>
            !['#panel-conversation', '#composer-slot'].includes(selector),
        ))
          for (const dimension of selector === '#scene'
            ? ['x', 'width']
            : ['x', 'y', 'width', 'height'])
            assert.ok(
              Math.abs(
                parentBounds[selector][dimension] -
                  agentBounds[selector][dimension],
              ) <= 1,
              `Selection moved ${selector} ${dimension} at ${width}: ${JSON.stringify({parentBounds, agentBounds})}`,
            );
        for (const bounds of [parentBounds, agentBounds])
          assert.ok(
            bounds['#scene'].height >= 180,
            `Scene must remain usable at ${width}: ${JSON.stringify(bounds['#scene'])}`,
          );
        assert.deepEqual(
          await evaluate(() => ({
            model: document.getElementById('factory-model').textContent,
            effortHidden: document.getElementById('factory-effort').hidden,
          })),
          {model: 'fixture/small', effortHidden: true},
        );
        assert.ok(agentBounds['#panel-conversation'].height >= 90);
        assert.ok(
          agentBounds['#composer-slot'].y +
            agentBounds['#composer-slot'].height <=
            agentBounds['#inspector'].y + agentBounds['#inspector'].height,
        );
        assert.equal(
          await evaluate(
            () => document.getElementById('agent-task-dock').hidden,
          ),
          true,
        );
        assert.equal(
          await evaluate(
            () => document.getElementById('parent-controls').hidden,
          ),
          false,
        );

        await evaluate(() => document.getElementById('back-to-parent').click());
        await settle();
        const returnedBounds = await geometry();
        const returnedKind = await inspectKind();
        assert.equal(returnedKind.label, 'Main agent');
        assert.equal(returnedKind.kind, 'main');
        assert.equal(returnedKind.marker, 'main');
        assert.equal(returnedKind.mainIcon, true);
        assert.equal(returnedKind.primaryIcon, false);
        assert.equal(returnedKind.subagentIcon, false);
        assert.deepEqual(
          returnedBounds,
          parentBounds,
          `Returning to parent must preserve geometry at ${width}`,
        );
      }

      await evaluate(() =>
        [...document.querySelectorAll('#active-workers .worker-card')]
          .find(card => card.textContent.includes('Delegated agent'))
          .click(),
      );
      await settle();
      assert.deepEqual(
        await evaluate(() => {
          const card = [
            ...document.querySelectorAll('#active-workers .worker-card'),
          ].find(item => item.textContent.includes('Delegated agent'));
          const glyph = card.querySelector('.robot-glyph');
          return {
            inspectorKind:
              document.getElementById('inspector').dataset.conversationKind,
            marker:
              document.querySelector('.conversation-kind').dataset.agentKind,
            label: document.getElementById('conversation-kind-label')
              .textContent,
            selectedMark: (() => {
              const mark = document.getElementById(
                'selected-conversation-mark',
              );
              return {
                kind: mark.dataset.agentKind,
                subagent: mark.classList.contains('robot-subagent'),
                crown:
                  getComputedStyle(mark.querySelector('.robot-crown'))
                    .display !== 'none',
                label: mark.getAttribute('aria-label'),
              };
            })(),
            mainIcon:
              getComputedStyle(document.querySelector('.kind-main-icon'))
                .display !== 'none',
            primaryIcon:
              getComputedStyle(document.querySelector('.kind-primary-icon'))
                .display !== 'none',
            subagentIcon:
              getComputedStyle(document.querySelector('.kind-subagent-icon'))
                .display !== 'none',
            cardKind: card.dataset.agentKind,
            glyphKind: glyph.dataset.agentKind,
            glyphClass: glyph.classList.contains('robot-subagent'),
            crown:
              getComputedStyle(glyph.querySelector('.robot-crown')).display !==
              'none',
            glyphLabel: glyph.getAttribute('aria-label'),
          };
        }),
        {
          inspectorKind: 'subagent',
          marker: 'subagent',
          label: 'Subagent',
          selectedMark: {
            kind: 'subagent',
            subagent: true,
            crown: false,
            label: 'Subagent',
          },
          mainIcon: false,
          primaryIcon: false,
          subagentIcon: true,
          cardKind: 'subagent',
          glyphKind: 'subagent',
          glyphClass: true,
          crown: false,
          glyphLabel: 'Subagent',
        },
        'Explicit subagents use the subagent marker in cards and the inspector',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await screenshot('conversation-agent-types');
        const themes = await evaluate(() =>
          [...document.getElementById('factory-theme').options].map(
            option => option.value,
          ),
        );
        for (const theme of themes) {
          await evaluate(theme => {
            const select = document.getElementById('factory-theme');
            select.value = theme;
            select.dispatchEvent(new Event('change'));
          }, theme);
          await screenshot(`conversation-agent-types-${theme}`);
        }
        await evaluate(() => {
          const select = document.getElementById('factory-theme');
          select.value = window.fixtureTheme || 'factory';
          select.dispatchEvent(new Event('change'));
        });
        window.setContentSize(1100, 760);
        window.webContents.setZoomFactor(1.5);
        await settle();
        await screenshot('conversation-agent-types-compact-zoom');
        window.webContents.setZoomFactor(1);
        window.setContentSize(1600, 1000);
        await settle();
      }
    },
  );

  await run(
    'full conversation history skips offscreen rendering and preserves scrolling, selection and disclosures',
    async () => {
      const parent = hub.sessions[0];
      const first = 'Beginning of the complete conversation';
      const input = `${'Original file line\n'.repeat(5000)}End of original file`;
      const output = `${'Full output line\n'.repeat(5000)}End of complete output`;
      parent.conversation = Array.from({length: 320}, (_, index) => ({
        id: `history-${index}`,
        role: index % 3 === 1 ? 'tool' : index % 3 === 0 ? 'user' : 'assistant',
        at,
        text:
          index === 0
            ? first
            : index === 319
              ? 'Latest conversation message'
              : `Message ${index}\n${'Conversation content. '.repeat(40 + (index % 10))}`,
        ...(index % 3 === 1
          ? {
              toolName: 'read',
              input: JSON.stringify({path: `file-${index}.md`}),
              status: 'completed',
            }
          : {}),
      }));
      parent.conversation[1].input = JSON.stringify({
        path: 'original.md',
        content: input,
      });
      parent.conversation[1].text = output;
      parent.conversation[319].role = 'assistant';
      await publish();
      await until(() => {
        const body = document.getElementById('panel-conversation');
        return body.scrollHeight - body.scrollTop - body.clientHeight < 5;
      }, 'Full history must open at the latest message');
      const rendering = await evaluate(() => {
        const rows = [...document.querySelectorAll('#conversation > li')];
        return {
          count: rows.length,
          rendered: rows.filter(row =>
            row.firstElementChild.checkVisibility({
              contentVisibilityAuto: true,
            }),
          ).length,
          latest: rows.at(-1).textContent,
        };
      });
      assert.equal(rendering.count, 320);
      assert.ok(
        rendering.rendered > 0 && rendering.rendered < 40,
        `Only nearby messages should render, got ${rendering.rendered}`,
      );
      assert.match(rendering.latest, /Latest conversation message/);
      await evaluate(() => {
        const follow = document.getElementById('follow-conversation');
        follow.checked = false;
        follow.dispatchEvent(new Event('change'));
        document.getElementById('panel-conversation').scrollTop = 0;
      });
      await until(
        () =>
          document
            .querySelector('#conversation .conversation-text')
            .checkVisibility({contentVisibilityAuto: true}),
        'Oldest message must render on scroll',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .conversation-text')
              .textContent,
        ),
        first,
      );
      await evaluate(() =>
        document.querySelector('#conversation details summary').click(),
      );
      await settle();
      assert.deepEqual(
        await evaluate(() => ({
          input: document.querySelector('#conversation .tool-input')
            .textContent,
          output: document.querySelector('#conversation .tool-output')
            .textContent,
        })),
        {input: `Read file\n\nPath: original.md\n\nContent:\n${input}`, output},
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('full-history-oldest');

      await evaluate(() => {
        const text = document.querySelector(
          '#conversation .conversation-text',
        ).firstChild;
        const range = document.createRange();
        range.selectNodeContents(text);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.historyRow = document.querySelector('#conversation > li');
        window.historyText = text;
        window.historyScroll =
          document.getElementById('panel-conversation').scrollTop;
      });
      parent.conversation[319].text += '\nNew streamed content';
      parent.conversation[319].streaming = true;
      parent.conversation.push({
        id: 'history-new',
        role: 'assistant',
        at,
        text: 'Newest answer',
      });
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          selection: window.getSelection().toString(),
          row:
            document.querySelector('#conversation > li') === window.historyRow,
          text:
            document.querySelector('#conversation .conversation-text')
              .firstChild === window.historyText,
          scroll:
            Math.abs(
              document.getElementById('panel-conversation').scrollTop -
                window.historyScroll,
            ) < 2,
        })),
        {selection: first, row: true, text: true, scroll: true},
      );
      await evaluate(() => {
        window.getSelection().removeAllRanges();
        document
          .querySelectorAll('#conversation > li')[159]
          .scrollIntoView({block: 'start'});
      });
      await until(
        () =>
          document
            .querySelectorAll('#conversation > li')[159]
            .firstElementChild.checkVisibility({contentVisibilityAuto: true}),
        'Middle history must render on scroll',
      );
      assert.match(
        await evaluate(
          () =>
            document.querySelectorAll('#conversation > li')[159].textContent,
        ),
        /Message 159/,
      );
      await evaluate(() => {
        const follow = document.getElementById('follow-conversation');
        follow.checked = true;
        follow.dispatchEvent(new Event('change'));
      });
      await until(() => {
        const body = document.getElementById('panel-conversation');
        return body.scrollHeight - body.scrollTop - body.clientHeight < 5;
      }, 'Follow must return to the end of full history');
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('full-history-latest');
      await reloadPage();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#conversation > li').length,
        ),
        321,
      );
      await evaluate(() => {
        const follow = document.getElementById('follow-conversation');
        follow.checked = false;
        follow.dispatchEvent(new Event('change'));
        document.getElementById('panel-conversation').scrollTop = 0;
      });
      await settle();
      assert.equal(
        await evaluate(
          () => document.querySelector('#conversation details').open,
        ),
        true,
        'Expanded historical tools survive reload',
      );
      window.setContentSize(1100, 760);
      window.webContents.setZoomFactor(1.5);
      await settle();
      assert.equal(
        await evaluate(() => {
          const body = document.getElementById('panel-conversation');
          const rect = body.getBoundingClientRect();
          return (
            rect.height > 100 &&
            rect.width > 200 &&
            rect.bottom <= innerHeight &&
            rect.right <= innerWidth
          );
        }),
        true,
        'Full history remains usable in a compact zoomed window',
      );
      await evaluate(() => {
        document
          .querySelector('#conversation .conversation-text')
          .scrollIntoView({block: 'start'});
      });
      await settle();
      assert.equal(
        await evaluate(() => {
          const body = document
            .getElementById('panel-conversation')
            .getBoundingClientRect();
          const text = document
            .querySelector('#conversation .conversation-text')
            .getBoundingClientRect();
          return text.top >= body.top - 1 && text.bottom <= body.bottom + 1;
        }),
        true,
        'Historical text can be read in the compact viewport',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('full-history-compact');
      window.webContents.setZoomFactor(1);
      window.setContentSize(1600, 1000);
      parent.agents = Array.from({length: 125}, (_, index) => ({
        id: `historical-worker-${index}`,
        name: `Historical worker ${index}`,
        cwd: directory,
        model: 'fixture/small',
        task: `Worker task ${index}`,
        status: 'completed',
        activity: 'Completed',
        createdAt: at,
        finishedAt: new Date(Date.parse(at) + index * 1000).toISOString(),
        conversation: index === 0 ? structuredClone(parent.conversation) : [],
      }));
      parent.totalAgents = parent.agents.length;
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#history-workers button').length,
        ),
        125,
      );
      await evaluate(() => {
        const search = document.getElementById('history-search');
        search.value = 'Historical worker 0';
        search.dispatchEvent(new Event('input', {bubbles: true}));
        document.querySelector('#history-workers button').click();
      });
      await settle();
      assert.equal(
        await evaluate(
          () => document.getElementById('inspector-title').textContent,
        ),
        'Historical worker 0',
      );
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#conversation > li').length,
        ),
        321,
      );
      await evaluate(() => {
        const follow = document.getElementById('follow-conversation');
        follow.checked = false;
        follow.dispatchEvent(new Event('change'));
        document.getElementById('panel-conversation').scrollTop = 0;
      });
      await settle();
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .conversation-text')
              .textContent,
        ),
        first,
      );
    },
  );

  await run(
    'readable operations decode compact JSON fields and results, preserve selection and keep HTML inert',
    async () => {
      const html = '<script>window.operationInjected = true</script>';
      const operations = [
        ['read', {path: '/fixture/file.md', offset: 4, limit: 10}],
        [
          'write',
          {path: '/fixture/file.md', content: `# Header\n${html}\n- [ ] Task`},
        ],
        [
          'edit',
          {
            path: '/fixture/file.md',
            edits: [{oldText: 'first\nsecond', newText: 'third\nfourth'}],
          },
        ],
        ['bash', {command: 'printf "hello\\n"\npwd', timeout: 3}],
        ['agent_send', {id: 'worker', message: 'Read files\nThen report'}],
        [
          'browse',
          {url: 'https://example.com', method: 'POST', body: 'first\nsecond'},
        ],
        [
          'json_query',
          {
            path: 'data.json',
            select: ['name', 'status'],
            where: {status: 'ready'},
          },
        ],
        [
          'custom_tool',
          {data: {nested: [1, 2]}, literal: 'backslash\\n stays literal'},
        ],
      ];
      hub.sessions[0].conversation = operations.map(
        ([toolName, input], index) => ({
          id: `readable-${index}`,
          role: 'tool',
          toolName,
          at,
          input: JSON.stringify(input),
          status: 'completed',
          text: JSON.stringify({
            stdout: `first line\n${html}`,
            stderr: 'warning\nmore detail',
            exitCode: 1,
          }),
          ...(index === 3
            ? {error: 'Execution failed\nExit code 1', status: 'failed'}
            : {}),
        }),
      );
      hub.sessions[0].events = [
        {
          id: 'readable-event',
          sourceId: 'parent',
          sourceName: 'Parent',
          kind: 'tool',
          at,
          message: 'Writing file',
          conversationId: 'readable-1',
          details: {Tool: 'write'},
        },
      ];
      await publish();
      const view = await evaluate(() => ({
        inputs: [...document.querySelectorAll('#conversation .tool-input')].map(
          item => item.textContent,
        ),
        outputs: [
          ...document.querySelectorAll('#conversation .tool-output'),
        ].map(item => item.textContent),
        injected: !!window.operationInjected,
        scripts: document.querySelectorAll('#conversation script').length,
        error: document.querySelector(
          '#conversation .conversation-error:not([hidden])',
        ).textContent,
      }));
      assert.match(
        view.inputs[0],
        /Read file\n\nPath: \/fixture\/file.md\n\nStart line: 4\n\nLine limit: 10/,
      );
      assert.ok(view.inputs[1].includes(`# Header\n${html}\n- [ ] Task`));
      assert.match(view.inputs[2], /Original text:\nfirst\nsecond/);
      assert.match(view.inputs[2], /Replacement text:\nthird\nfourth/);
      assert.ok(view.inputs[3].includes('Command:\nprintf "hello\\n"\npwd'));
      assert.ok(view.inputs[4].includes('Message:\nRead files\nThen report'));
      assert.ok(view.inputs[5].includes('Body:\nfirst\nsecond'));
      assert.match(view.inputs[6], /Select:\n/);
      assert.match(view.inputs[7], /backslash\\n stays literal/);
      assert.ok(
        view.outputs.every(
          output =>
            output.includes(`Standard output:\nfirst line\n${html}`) &&
            output.includes('Standard error:\nwarning\nmore detail') &&
            output.includes('Exit code: 1'),
        ),
      );
      assert.equal(view.injected, false);
      assert.equal(view.scripts, 0);
      assert.equal(view.error, 'Execution failed\nExit code 1');
      await evaluate(() => {
        document.querySelector('#conversation details').open = true;
        const text = document.querySelector(
          '#conversation .tool-input',
        ).firstChild;
        const start = text.data.indexOf('/fixture/file.md');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 16);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.fixtureInput = text;
      });
      hub.sessions[0].conversation[0].input = JSON.stringify({
        path: '/fixture/file.md',
        offset: 4,
        limit: 20,
      });
      await publish();
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .tool-input').firstChild ===
            window.fixtureInput,
        ),
        true,
      );
      assert.equal(
        await evaluate(() => window.getSelection().toString()),
        '/fixture/file.md',
      );
      await evaluate(() => document.getElementById('tab-feed').click());
      const feed = await evaluate(
        () => document.getElementById('live-feed').textContent,
      );
      assert.ok(feed.includes(`# Header\n${html}\n- [ ] Task`));
      assert.ok(feed.includes(`Standard output:\nfirst line\n${html}`));
      assert.equal(await evaluate(() => !!window.operationInjected), false);
      hub.sessions[0].conversation[0].text = JSON.stringify(
        'decoded line\nsecond line',
      );
      hub.sessions[0].conversation[1].text = 'x'.repeat(100_000);
      await publish();
      await evaluate(() => document.getElementById('tab-conversation').click());
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .tool-output').textContent,
        ),
        'decoded line\nsecond line',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelectorAll('#conversation .tool-output')[1]
              .textContent,
        ),
        'x'.repeat(100_000),
      );
    },
  );

  await run(
    'Context explains included Markdown and available resources with safe previews and parent scope',
    async () => {
      const preview =
        '# Project rules\nUse <script>window.contextInjected = true</script> & keep paths.';
      resources.get('alpha').contextFiles = [
        {
          path: '/fixture/project/AGENTS.md',
          name: 'AGENTS.md',
          kind: 'instructions',
          status: 'included',
          description: 'Project instructions loaded into the system prompt.',
          content: preview,
        },
        {
          path: '/fixture/prompts/SYSTEM.md',
          name: 'SYSTEM.md',
          kind: 'system',
          status: 'included',
          description: 'Replaces the default system prompt.',
          content: 'You help maintain this project.',
        },
        {
          path: '/fixture/project/docs/design.md',
          name: 'design.md',
          kind: 'document',
          status: 'included',
          description:
            'Read tool excerpt, lines 10–20, retained in the conversation.',
          content: '## Design excerpt\nA small desktop inspector.',
        },
        {
          path: '/fixture/skills/inspect/SKILL.md',
          name: 'inspect',
          kind: 'skill',
          status: 'available',
          description:
            'Name and description advertised in the system prompt; full body read on demand.',
        },
        {
          path: '/fixture/prompts/review.md',
          name: 'review',
          kind: 'template',
          status: 'available',
          description:
            'Review the current diff. Template content enters the user message when /review is invoked.',
        },
      ];
      hub.sessions[0].session.context = {
        tokens: 3200,
        window: 64000,
        percent: 5,
      };
      hub.sessions[0].agents = [
        {
          id: 'context-agent',
          name: 'Context agent',
          task: 'Inspect the project',
          cwd: directory,
          status: 'running',
          createdAt: at,
          startedAt: at,
          updatedAt: at,
        },
      ];
      hub.sessions[0].totalAgents = 1;
      await publish();
      await evaluate(() => {
        document.querySelector('#active-workers button').click();
        document.getElementById('back-to-parent').click();
        document.getElementById('tab-context').focus();
        document.getElementById('tab-context').click();
      });
      await until(
        () => document.querySelectorAll('.context-file').length === 5,
        'Context files did not load',
      );
      assert.equal(
        await evaluate(() => document.getElementById('open-context')),
        null,
      );
      assert.equal(
        await evaluate(
          () =>
            !!document
              .getElementById('markdown-launcher')
              .closest('.factory-file-actions'),
        ),
        true,
      );
      const display = await evaluate(() => ({
        parent: document.getElementById('context-recipient').textContent,
        selectedAgent: document.getElementById('inspector-title').textContent,
        selected: document
          .getElementById('tab-context')
          .getAttribute('aria-selected'),
        focused: document.activeElement.id,
        panels: [
          ...document.querySelectorAll('[role="tabpanel"][id^="panel-"]'),
        ]
          .filter(item => !item.hidden)
          .map(item => item.id),
        headings: [...document.querySelectorAll('.context-section h3')].map(
          item => item.textContent,
        ),
        paths: [...document.querySelectorAll('.context-file-path')].map(
          item => item.textContent,
        ),
        labels: [
          ...document.querySelectorAll('.context-file-heading span'),
        ].map(item => item.textContent),
        available: document.querySelectorAll('.context-section')[1].textContent,
        previews: document.querySelectorAll('.context-preview').length,
        injected: !!window.contextInjected,
        scripts: document.querySelectorAll('#context-files script').length,
        preview: document.querySelector('.context-preview pre').textContent,
      }));
      assert.equal(display.parent, 'Alpha factory');
      assert.equal(display.selectedAgent, 'Alpha factory');
      assert.equal(display.selected, 'true');
      assert.equal(display.focused, 'tab-context');
      assert.deepEqual(display.panels, ['panel-context']);
      assert.deepEqual(display.headings, [
        'Included in context',
        'Available resources',
      ]);
      assert.deepEqual(
        display.paths,
        resources.get('alpha').contextFiles.map(file => file.path),
      );
      assert.deepEqual(display.labels, [
        'Project instructions',
        'System prompt',
        'Read document',
        'Skill',
        'Prompt template',
      ]);
      assert.match(
        display.available,
        /Name and description advertised in the system prompt; full body read on demand/,
      );
      assert.match(
        display.available,
        /Template content enters the user message when \/review is invoked/,
      );
      assert.equal(display.previews, 3);
      assert.equal(display.injected, false);
      assert.equal(display.scripts, 0);
      assert.equal(display.preview, preview);
      await evaluate(() =>
        document.querySelector('.context-preview summary').click(),
      );
      assert.equal(
        await evaluate(() => document.querySelector('.context-preview').open),
        true,
      );
      resources.get('alpha').contextFiles[0].description += ' Updated.';
      await evaluate(() => document.getElementById('refresh-context').click());
      await until(
        () =>
          document
            .querySelector('.context-file')
            .textContent.includes('Updated.'),
        'Updated file description did not arrive',
      );
      await publish();
      assert.equal(
        await evaluate(() => document.querySelector('.context-preview').open),
        true,
        'Snapshot updates must preserve an expanded preview',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        window.setContentSize(1600, 1400);
        await screenshot('context-files');
        window.setContentSize(1600, 1000);
        await settle();
      }
      await evaluate(() => document.getElementById('tab-context').focus());
      await press('Left');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'tab-tokens',
      );
      await press('Right');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'tab-context',
      );
      await press('Home');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'tab-conversation',
      );
      await press('End');
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'tab-speed',
      );
    },
  );

  await run(
    'Context session switching rejects delayed results and recovers from errors and empty metadata',
    async () => {
      const doc = name => ({
        path: `/fixture/${name}.md`,
        name: `${name}.md`,
        kind: 'instructions',
        status: 'included',
        description: 'Loaded project instructions',
      });
      resources.get('alpha').contextFiles = [doc('alpha')];
      resources.get('beta').contextFiles = [doc('beta')];
      featureDelays.set('alpha', 350);
      await evaluate(() => document.getElementById('tab-context').click());
      await evaluate(() => {
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Beta factory'))
          .click();
        document.getElementById('tab-context').click();
      });
      await until(
        () =>
          document.querySelector('.context-file-path')?.textContent ===
          '/fixture/beta.md',
        'Beta context did not load',
      );
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(
        await evaluate(
          () => document.querySelector('.context-file-path').textContent,
        ),
        '/fixture/beta.md',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('context-recipient').textContent,
        ),
        'Beta factory',
      );
      featureErrors.set('beta', 'Context loader unavailable');
      await evaluate(() => document.getElementById('refresh-context').click());
      await until(
        () => !document.getElementById('context-error').hidden,
        'Context error was not shown',
      );
      assert.match(
        await evaluate(
          () => document.getElementById('context-error').textContent,
        ),
        /Context loader unavailable/,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('refresh-context').disabled,
        ),
        false,
      );
      featureErrors.delete('beta');
      resources.get('beta').contextFiles = [];
      await evaluate(() => document.getElementById('refresh-context').click());
      await until(
        () =>
          document.getElementById('context-error').hidden &&
          document.querySelectorAll('.context-file').length === 0 &&
          !document.getElementById('refresh-context').disabled,
        'Context refresh did not recover',
      );
      assert.match(
        await evaluate(
          () => document.getElementById('context-status').textContent,
        ),
        /No context files reported/,
      );
      delete resources.get('beta').contextFiles;
      await evaluate(() => document.getElementById('refresh-context').click());
      await until(
        () => !document.getElementById('refresh-context').disabled,
        'Optional metadata did not finish loading',
      );
      assert.equal(
        await evaluate(() => document.querySelectorAll('.context-file').length),
        0,
      );
      // Two requests for one parent complete out of order; the later request wins.
      featureDelays.set('alpha', 350);
      await evaluate(() => {
        [...document.querySelectorAll('#parents button')]
          .find(item => item.textContent.includes('Alpha factory'))
          .click();
        document.getElementById('tab-context').click();
      });
      featureDelays.delete('alpha');
      resources.get('alpha').contextFiles = [doc('fresh-alpha')];
      await evaluate(() => {
        document.getElementById('tab-conversation').click();
        document.getElementById('tab-context').click();
      });
      await until(
        () =>
          document.querySelector('.context-file-path')?.textContent ===
          '/fixture/fresh-alpha.md',
        'Fresh Alpha context did not load',
      );
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(
        await evaluate(
          () => document.querySelector('.context-file-path').textContent,
        ),
        '/fixture/fresh-alpha.md',
      );
    },
  );

  await run(
    'Context refreshes on tab entry reload completed tool reads and compaction',
    async () => {
      const doc = name => ({
        path: `/fixture/${name}.md`,
        name: `${name}.md`,
        kind: 'document',
        status: 'included',
        description: 'Read excerpt retained in conversation',
        content: `# ${name}`,
      });
      resources.get('alpha').contextFiles = [doc('original')];
      await evaluate(() => document.getElementById('tab-context').click());
      await until(
        () =>
          document.querySelector('.context-file-path')?.textContent ===
          '/fixture/original.md',
        'Initial document did not load',
      );
      resources.get('alpha').contextFiles = [doc('on-open')];
      await evaluate(() => {
        document.getElementById('tab-conversation').click();
        document.getElementById('tab-context').click();
      });
      await until(
        () =>
          document.querySelector('.context-file-path')?.textContent ===
          '/fixture/on-open.md',
        'Tab entry did not refresh context',
      );
      const before = featureRequests.length;
      resources.get('alpha').contextFiles.push(doc('read-result'));
      hub.sessions[0].conversation.push({
        id: 'markdown-read',
        role: 'tool',
        toolName: 'read',
        status: 'completed',
        streaming: false,
        text: '# read-result',
        at,
      });
      await publish();
      await until(
        () => document.querySelectorAll('.context-file').length === 2,
        'Completed read did not refresh visible context',
      );
      assert.ok(featureRequests.length > before);
      resources.get('alpha').contextFiles.pop();
      hub.sessions[0].conversation = hub.sessions[0].conversation.filter(
        item => item.id !== 'markdown-read',
      );
      hub.sessions[0].conversation.push({
        id: 'context-compaction',
        role: 'assistant',
        text: 'Earlier work summarized.',
        at,
      });
      await publish();
      await until(
        () => document.querySelectorAll('.context-file').length === 1,
        'Context retained a read removed during compaction',
      );
      hub.sessions[0].session.status = 'idle';
      await publish();
      await evaluate(() => document.getElementById('open-commands').click());
      await until(
        () => !document.getElementById('reload-session').disabled,
        'Session commands did not load',
      );
      resources.get('alpha').contextFiles = [doc('after-reload')];
      await evaluate(() => document.getElementById('reload-session').click());
      await until(
        () =>
          document.querySelector('.context-file-path')?.textContent ===
          '/fixture/after-reload.md',
        'Reload did not refresh context',
      );
      assert.ok(
        calls.some(
          call =>
            call.method === 'prompt' &&
            call.sessionId === 'alpha' &&
            call.request.prompt === '/reload',
        ),
      );
      await evaluate(() => document.getElementById('close-commands').click());
    },
  );

  await run(
    'Tokens shows measured input output cache cost and parent and worker context usage',
    async () => {
      hub.sessions[0].session.context = {
        tokens: 3200,
        window: 64000,
        percent: 5,
      };
      hub.sessions[0].usage = {
        input: 1200,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 2000,
        cost: 0.0184,
        truncated: false,
        calls: [
          {
            id: 'alpha-assistant',
            at,
            model: 'fixture/small',
            input: 1200,
            output: 200,
            cacheRead: 500,
            cacheWrite: 100,
            totalTokens: 2000,
            cost: 0.0184,
            toolNames: ['bash'],
            stopReason: 'toolUse',
          },
        ],
      };
      hub.sessions[0].agents = [
        {
          id: 'worker-1',
          name: 'Fixture worker',
          task: 'Read the fixture project',
          cwd: directory,
          status: 'completed',
          createdAt: at,
          startedAt: at,
          finishedAt: at,
          model: 'fixture/worker',
          context: {tokens: 8000, window: 32000, percent: 25},
          activity: 'Completed fixture task',
          output: 'Fixture result',
          autoCleanup: false,
          taskTruncated: false,
          outputTruncated: false,
          usage: {
            input: 3000,
            output: 100,
            cacheRead: 150,
            cacheWrite: 50,
            totalTokens: 3300,
            cost: 0.0123,
            truncated: false,
            calls: [
              {
                id: 'worker-call',
                at,
                model: 'fixture/worker',
                input: 3000,
                output: 100,
                cacheRead: 150,
                cacheWrite: 50,
                totalTokens: 3300,
                cost: 0.0123,
                toolNames: ['read'],
                stopReason: 'stop',
              },
            ],
          },
        },
        {
          id: 'worker-2',
          name: 'Other worker',
          task: 'Do not show this worker usage',
          cwd: directory,
          status: 'completed',
          createdAt: at,
          startedAt: at,
          finishedAt: at,
          model: 'fixture/other-worker',
          context: {tokens: 12345, window: 50000, percent: 24.69},
          activity: 'Completed another task',
          output: 'Other result',
          autoCleanup: false,
          taskTruncated: false,
          outputTruncated: false,
          usage: {
            input: 9000,
            output: 500,
            cacheRead: 250,
            cacheWrite: 126,
            totalTokens: 9876,
            cost: 0.0456,
            truncated: false,
            calls: [],
          },
        },
      ];
      hub.sessions[0].totalAgents = 2;
      await publish();
      await evaluate(() => document.getElementById('tab-tokens').click());
      const counts = await evaluate(() => {
        const count = id =>
          Number(document.getElementById(id).textContent.replace(/[^\d]/g, ''));
        return {
          input: count('usage-input'),
          output: count('usage-output'),
          cacheRead: count('usage-cache-read'),
          cacheWrite: count('usage-cache-write'),
          total: count('usage-total'),
          cost: document.getElementById('usage-cost').textContent,
          context: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuenow'),
          limit: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuemax'),
          rows: document.querySelectorAll('#usage-calls tr').length,
          call: document.querySelector('#usage-calls tr').textContent,
          bars: ['input', 'output', 'cache-read', 'cache-write'].map(
            id => document.getElementById(`usage-bar-${id}`).style.width,
          ),
        };
      });
      assert.deepEqual(
        {...counts, call: undefined},
        {
          input: 1200,
          output: 200,
          cacheRead: 500,
          cacheWrite: 100,
          total: 2000,
          cost: '$0.0184',
          context: '3200',
          limit: '64000',
          rows: 1,
          call: undefined,
          bars: ['60%', '10%', '25%', '5%'],
        },
      );
      assert.match(counts.call, /Requested bash/);
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        for (const [width, height] of [
          [1100, 760],
          [1600, 1000],
        ]) {
          window.setContentSize(width, height);
          await settle();
          await screenshot(`tokens-${width}x${height}`);
        }
      }
      assert.deepEqual(
        await evaluate(() =>
          [...document.getElementById('usage-unit').options].map(
            item => item.value,
          ),
        ),
        ['parent', 'worker-1', 'worker-2'],
      );
      await evaluate(() =>
        [...document.querySelectorAll('#history-workers button')]
          .find(button => button.textContent.includes('Fixture worker'))
          .click(),
      );
      assert.deepEqual(
        await evaluate(() => ({
          text: document
            .getElementById('context-meter')
            .textContent.replace(/[^\dA-Za-z%·/—]/g, ''),
          hidden: document.getElementById('context-meter').hidden,
        })),
        {text: '25%·8000/32000tokens', hidden: false},
        'The selected worker header shows its context usage',
      );
      await evaluate(() => document.getElementById('tab-tokens').click());
      await evaluate(() => {
        const selector = document.getElementById('usage-unit');
        selector.value = 'worker-1';
        selector.dispatchEvent(new Event('change', {bubbles: true}));
      });
      assert.deepEqual(
        await evaluate(() => ({
          recipient: document.getElementById('usage-recipient').textContent,
          header: document
            .getElementById('context-meter')
            .textContent.replace(/[^\dA-Za-z%·/—]/g, ''),
          totals: ['input', 'output', 'cache-read', 'cache-write', 'total'].map(
            id =>
              Number(
                document
                  .getElementById(`usage-${id}`)
                  .textContent.replace(/[^\d]/g, ''),
              ),
          ),
          cost: document.getElementById('usage-cost').textContent,
          context: document
            .getElementById('usage-context')
            .textContent.replace(/[^\dA-Za-z%·/—]/g, ''),
          contextNow: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuenow'),
          contextLimit: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuemax'),
          contextHidden: document.getElementById('context-budget-meter').hidden,
          otherWorkerVisible: [
            document.getElementById('usage-total').textContent,
            document.getElementById('usage-context').textContent,
          ].some(text => {
            const digits = text.replace(/\D/g, '');
            return digits.includes('9876') || digits.includes('12345');
          }),
          call: document.querySelector('#usage-calls .usage-call-link')
            .textContent,
        })),
        {
          recipient: 'Model usage for Fixture worker',
          header: '25%·8000/32000tokens',
          totals: [3000, 100, 150, 50, 3300],
          cost: '$0.0123',
          context: '8000/32000tokens',
          contextNow: '8000',
          contextLimit: '32000',
          contextHidden: false,
          otherWorkerVisible: false,
          call: 'Requested read',
        },
      );
      assert.equal(
        hub.sessions[0].usage.totalTokens,
        2000,
        'Worker usage must not replace parent accounting',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        for (const [width, height, zoom, name] of [
          [1600, 1000, 1, 'normal'],
          [900, 760, 1.5, 'compact-zoom'],
        ]) {
          window.setContentSize(width, height);
          window.webContents.setZoomFactor(zoom);
          await settle();
          const showWorkerContext = () =>
            evaluate(() => {
              document.activeElement?.blur();
              const panel = document.getElementById('panel-tokens');
              const section = document.getElementById('usage-context-section');
              const viewport = panel.getBoundingClientRect();
              const bounds = section.getBoundingClientRect();
              panel.scrollTop += bounds.top - viewport.top - 12;
              const context = document
                .getElementById('usage-context')
                .getBoundingClientRect();
              return {
                visible:
                  document.getElementById('usage-context').checkVisibility() &&
                  context.top >= viewport.top - 1 &&
                  context.bottom <= viewport.bottom + 1,
                scrollTop: panel.scrollTop,
                context: {top: context.top, bottom: context.bottom},
                viewport: {top: viewport.top, bottom: viewport.bottom},
              };
            });
          await showWorkerContext();
          await settle();
          const geometry = await showWorkerContext();
          assert.equal(
            geometry.visible,
            true,
            `Worker context must be visible before capture: ${JSON.stringify(geometry)}`,
          );
          await screenshot(`tokens-worker-context-${name}`);
        }
        window.setContentSize(1600, 1000);
        window.webContents.setZoomFactor(1);
        await settle();
      }

      hub.sessions[0].agents[0].context = {
        tokens: 0,
        window: 32000,
        percent: 0,
      };
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          header: document
            .getElementById('context-meter')
            .textContent.replace(/[^\dA-Za-z%·/—]/g, ''),
          panel: document
            .getElementById('usage-context')
            .textContent.replace(/[^\dA-Za-z%·/—]/g, ''),
          hidden: document.getElementById('context-budget-meter').hidden,
          now: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuenow'),
        })),
        {
          header: '0%·0/32000tokens',
          panel: '0/32000tokens',
          hidden: false,
          now: '0',
        },
        'Zero worker context remains a measured value',
      );
      hub.sessions[0].agents[0].context = {
        tokens: null,
        window: 32000,
        percent: null,
      };
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          header: document
            .getElementById('context-meter')
            .textContent.replace(/[^\dA-Za-z%·/—]/g, ''),
          headerHidden: document.getElementById('context-meter').hidden,
          panel: document.getElementById('usage-context').textContent,
          meterHidden: document.getElementById('context-budget-meter').hidden,
        })),
        {
          header: '—·—/32000tokens',
          headerHidden: false,
          panel: 'Available after the next response',
          meterHidden: true,
        },
        'Null worker context is shown as unknown',
      );
      hub.sessions[0].agents[0].context = undefined;
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          header: document.getElementById('context-meter').textContent,
          headerHidden: document.getElementById('context-meter').hidden,
          panel: document.getElementById('usage-context').textContent,
          meterHidden: document.getElementById('context-budget-meter').hidden,
        })),
        {
          header: '—',
          headerHidden: true,
          panel: 'Available after the next response',
          meterHidden: true,
        },
        'Missing worker context is shown as unknown',
      );
      await evaluate(() => {
        const selector = document.getElementById('usage-unit');
        selector.value = 'parent';
        selector.dispatchEvent(new Event('change', {bubbles: true}));
      });
      assert.deepEqual(
        await evaluate(() => ({
          total: Number(
            document
              .getElementById('usage-total')
              .textContent.replace(/[^\d]/g, ''),
          ),
          contextHidden: document.getElementById('usage-context-section')
            .hidden,
        })),
        {total: 2000, contextHidden: false},
      );
      hub.sessions[0].usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        calls: [],
        truncated: false,
      };
      hub.sessions[0].session.context.tokens = 0;
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          totals: ['input', 'output', 'cache-read', 'cache-write', 'total'].map(
            id => document.getElementById(`usage-${id}`).textContent,
          ),
          cost: document.getElementById('usage-cost').textContent,
          bars: ['input', 'output', 'cache-read', 'cache-write'].map(
            id => document.getElementById(`usage-bar-${id}`).style.width,
          ),
          empty: !document.getElementById('usage-empty').hidden,
          tableHidden: document.getElementById('usage-table').hidden,
          contextVisible: !document.getElementById('context-budget-meter')
            .hidden,
          context: document
            .getElementById('context-budget-meter')
            .getAttribute('aria-valuenow'),
        })),
        {
          totals: ['0', '0', '0', '0', '0'],
          cost: '$0.0000',
          bars: ['0%', '0%', '0%', '0%'],
          empty: true,
          tableHidden: true,
          contextVisible: true,
          context: '0',
        },
      );
      assert.deepEqual(
        calls.filter(
          call =>
            !(
              call.method === 'agentSession' &&
              call.request.action === 'features'
            ),
        ),
        [],
        'Viewing usage must not change a conversation',
      );
    },
  );

  await run(
    'conversation code filenames and web links use the active workspace and desktop routes',
    async () => {
      const source =
        '**`src/ai-worker.js`** contains the chess AI logic.\n\n`src/main.js` starts the AI worker.\n\nSee https://example.com/chess and `PLAN.md`.';
      for (const parent of hub.sessions)
        parent.conversation = [
          {
            id: 'linked-answer',
            role: 'assistant',
            text: source,
            at,
            streaming: true,
          },
        ];
      await publish();
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      await settle();
      const waitForCall = async method => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const call = calls.find(item => item.method === method);
          if (call) return call;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(`No ${method} call received`);
      };
      assert.deepEqual(
        await evaluate(() =>
          [
            ...document.querySelectorAll('#conversation .conversation-text a'),
          ].map(link => link.dataset.filePath || link.dataset.externalUrl),
        ),
        [
          'src/ai-worker.js',
          'src/main.js',
          'https://example.com/chess',
          'PLAN.md',
        ],
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .conversation-text strong a')
              ?.textContent,
        ),
        'src/ai-worker.js',
      );
      await evaluate(() => {
        const link = document.querySelector(
          '#conversation strong a[data-file-path="src/ai-worker.js"]',
        );
        window.fixtureLink = link;
        link.click();
      });
      assert.deepEqual(await waitForCall('openFile'), {
        method: 'openFile',
        sessionId: hub.sessions[1].session.id,
        path: 'src/ai-worker.js',
      });
      await evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(window.fixtureLink.firstChild);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      hub.sessions[1].conversation[0].text += '\nMore streamed text.';
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          sameLink:
            document.querySelector(
              '#conversation strong a[data-file-path="src/ai-worker.js"]',
            ) === window.fixtureLink,
          selection: window.getSelection().toString(),
        })),
        {sameLink: true, selection: 'src/ai-worker.js'},
      );
      await evaluate(() =>
        document.querySelector('#conversation a[data-external-url]').click(),
      );
      assert.deepEqual(await waitForCall('openExternal'), {
        method: 'openExternal',
        url: 'https://example.com/chess',
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('conversation-links');
      hub.sessions[1].conversation[0].text += '\nhttps://example.com/failure';
      await publish();
      await evaluate(() =>
        document
          .querySelector(
            '#conversation a[data-external-url="https://example.com/failure"]',
          )
          .click(),
      );
      await until(
        () =>
          !document.getElementById('app-error').hidden &&
          document
            .getElementById('app-error')
            .textContent.includes('Browser unavailable'),
        'Browser failure did not reach the application error handler',
      );
      await evaluate(() => {
        document.getElementById('app-error').hidden = true;
      });
      await evaluate(() =>
        document
          .querySelector('#conversation a[data-file-path="PLAN.md"]')
          .click(),
      );
      await until(
        () =>
          !document.getElementById('markdown-panel').hidden &&
          document
            .getElementById('markdown-preview')
            .textContent.includes('Agent tasks'),
        'Markdown code link did not open the in-app reader',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('markdown-file-path').textContent,
        ),
        'PLAN.md',
      );
    },
  );

  await run(
    'conversation bold renders as markers arrive and preserves streamed selection',
    async () => {
      hub.sessions[0].conversation = [
        {
          id: 'bold-answer',
          role: 'assistant',
          text: '- **IVA1 loads',
          at,
          streaming: true,
        },
      ];
      await publish();
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#conversation .conversation-text')
              .textContent,
        ),
        '- **IVA1 loads',
      );
      await evaluate(() => {
        const text = document.querySelector(
          '#conversation .conversation-text',
        ).firstChild;
        const start = text.data.indexOf('IVA1');
        window.getSelection().setBaseAndExtent(text, start + 4, text, start);
      });
      hub.sessions[0].conversation[0].text +=
        ' successfully**\n- __Second check passes__';
      await publish();
      assert.deepEqual(
        await evaluate(() => {
          const content = document.querySelector(
            '#conversation .conversation-text',
          );
          const strong = content.querySelector('strong');
          const retainedSelection = window.getSelection().toString();
          const backwards =
            window.getSelection().anchorNode === strong.firstChild;
          const range = document.createRange();
          range.selectNodeContents(strong.firstChild);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          window.fixtureBold = {element: strong, text: strong.firstChild};
          return {
            text: content.textContent,
            retainedSelection,
            backwards,
            bold: [...content.querySelectorAll('strong')].map(
              item => item.textContent,
            ),
            heavier:
              Number(getComputedStyle(strong).fontWeight) >
              Number(getComputedStyle(content).fontWeight),
          };
        }),
        {
          text: '- IVA1 loads successfully\n- Second check passes',
          retainedSelection: 'IVA1',
          backwards: true,
          bold: ['IVA1 loads successfully', 'Second check passes'],
          heavier: true,
        },
      );
      hub.sessions[0].conversation[0].text +=
        '\nMore streamed text.\n`**literal**`\n**<img src=x onerror=alert(1)>**';
      hub.sessions[0].conversation[0].streaming = false;
      await publish();
      assert.deepEqual(
        await evaluate(() => {
          const content = document.querySelector(
            '#conversation .conversation-text',
          );
          return {
            sameElement:
              content.querySelector('strong') === window.fixtureBold.element,
            sameText:
              content.querySelector('strong').firstChild ===
              window.fixtureBold.text,
            selection: window.getSelection().toString(),
            literal: content.textContent.includes('`**literal**`'),
            html: Boolean(content.querySelector('img, script')),
          };
        }),
        {
          sameElement: true,
          sameText: true,
          selection: 'IVA1 loads successfully',
          literal: true,
          html: false,
        },
      );
      await evaluate(() => window.getSelection().removeAllRanges());
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('conversation-bold');
    },
  );

  await run(
    'assistant stream preserves native text selection and row identity',
    async () => {
      hub.sessions[0].conversation = [
        {
          id: 'answer',
          role: 'assistant',
          text: 'Selectable answer',
          at,
          streaming: true,
        },
      ];
      await publish();
      await evaluate(() => {
        const row = document.querySelector('#conversation > li');
        const text = row.querySelector('.conversation-text').firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 10);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        window.fixtureNodes = {row, text};
      });
      hub.sessions[0].conversation[0].text += ' continues streaming';
      await publish();
      assert.deepEqual(
        await evaluate(() => ({
          row:
            document.querySelector('#conversation > li') ===
            window.fixtureNodes.row,
          text:
            document.querySelector('#conversation .conversation-text')
              .firstChild === window.fixtureNodes.text,
          selection: window.getSelection().toString(),
        })),
        {row: true, text: true, selection: 'Selectable'},
      );
    },
  );
  await run(
    'actions start collapsed and preserve disclosure choices through streaming, parent switches and reload',
    async () => {
      hub.sessions[0].conversation = [
        'read',
        'edit',
        'bash',
        'agent_spawn',
      ].map((toolName, index) => ({
        id: `action-${index}`,
        role: 'tool',
        toolName,
        at,
        input: 'src/example.ts',
        text: 'Output remains visible',
        status: 'completed',
      }));
      hub.sessions[0].events = [
        {
          id: 'event',
          at,
          sourceId: 'parent',
          sourceName: 'Alpha',
          kind: 'tool',
          message: 'Read src/example.ts',
          details: {Tool: 'read', Output: 'File contents'},
        },
      ];
      await publish();
      const initial = await evaluate(() =>
        [...document.querySelectorAll('#conversation > li')].map(row => ({
          open: row.querySelector('details').open,
          label: row.querySelector('.action-label').textContent,
          accent: getComputedStyle(row).borderLeftColor,
        })),
      );
      assert.ok(initial.every(row => !row.open));
      assert.equal(new Set(initial.map(row => row.accent)).size, 4);
      assert.deepEqual(
        initial.map(row => row.label),
        ['Read file', 'File change', 'Command', 'Agent'],
      );
      await evaluate(() =>
        document.querySelector('#conversation summary').click(),
      );
      await settle();
      hub.sessions[0].conversation[1].text += '\nMore output';
      await publish();
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Alpha'))
          .click(),
      );
      await reloadPage();
      assert.deepEqual(
        await evaluate(() =>
          [...document.querySelectorAll('#conversation details')].map(
            details => details.open,
          ),
        ),
        [true, false, false, false],
      );
      await evaluate(() => document.getElementById('tab-feed').click());
      assert.deepEqual(
        await evaluate(() => {
          const event = document.querySelector('#live-feed .feed-event');
          return {
            open: event.querySelector('details').open,
            compact:
              parseFloat(
                getComputedStyle(event.querySelector('.feed-event-message'))
                  .fontSize,
              ) <= 12,
            output: event.textContent.includes('File contents'),
          };
        }),
        {open: true, compact: true, output: true},
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('compact-live-feed');
      await evaluate(() => document.getElementById('tab-conversation').click());
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('conversation-actions');
      hub.sessions[0].conversation.push({
        id: 'final-response',
        role: 'assistant',
        at,
        text: 'The changes are ready.\n\nAssistant replies now have a clear accent, a brighter background, and more space around the text.\n\nThe robot jumps in surprise when you stop it, with a brief red alert across the factory.',
      });
      await publish();
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('assistant-response');
    },
  );

  await run(
    'menu theme selector is visible and applies and remembers every palette',
    async () => {
      hub.sessions[0].conversation.push(
        ...['read', 'edit', 'browse', 'agent_spawn', 'openai_image'].map(
          toolName => ({
            id: `theme-${toolName}`,
            role: 'tool',
            toolName,
            at,
            input: 'src/example.ts',
            text: 'Completed',
            status: 'completed',
          }),
        ),
      );
      await publish();
      await evaluate(() => {
        if (!document.getElementById('app-menu-panel').matches(':popover-open'))
          document.getElementById('app-menu-button').click();
      });
      const themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      assert.equal(
        themes.length,
        await evaluate(async () => (await import('./themes.js')).THEMES.length),
      );
      assert.ok(themes.includes('year1998'));
      const backgrounds = new Set();
      for (const id of themes) {
        const result = await evaluate(async id => {
          const {THEMES} = await import('./themes.js');
          const colors = THEMES.find(theme => theme.id === id).colors;
          const select = document.getElementById('factory-theme');
          select.value = id;
          select.dispatchEvent(new Event('change', {bubbles: true}));
          const roles = [
            ['#new-session', 'backgroundColor', 'accent'],
            ['#tab-conversation', 'color', 'accent'],
            ['.inspector-heading h2', 'color', 'heading'],
            [
              "#conversation [data-action='user'] strong",
              'color',
              'message-user',
            ],
            [
              "#conversation [data-action='assistant'] strong",
              'color',
              'message-assistant',
            ],
            ...['read', 'edit', 'command', 'web', 'agent', 'media'].map(
              action => [
                `#conversation [data-action='${action}'] .action-label`,
                'color',
                `action-${action}`,
              ],
            ),
          ];
          return {
            roles: roles.map(([selector, property, role]) => ({
              role,
              actual: getComputedStyle(document.querySelector(selector))[
                property
              ],
              expected:
                id === 'year1998' && selector === '#new-session'
                  ? 'rgba(0, 0, 0, 0)'
                  : id === 'year1998' && role === 'heading'
                    ? 'rgb(255, 255, 255)'
                    : `rgb(${[1, 3, 5].map(offset => parseInt(colors[role].slice(offset, offset + 2), 16)).join(', ')})`,
            })),
            selected: document.documentElement.dataset.theme,
            visible:
              select.getBoundingClientRect().height > 0 &&
              select.getBoundingClientRect().bottom <= innerHeight,
            background: getComputedStyle(document.querySelector('.panel'))
              .backgroundColor,
            stored: window.localStorage.getItem('varisdev.factory.theme'),
          };
        }, id);
        assert.equal(result.selected, id);
        assert.equal(result.stored, id);
        assert.equal(result.visible, true);
        for (const {role, actual, expected} of result.roles)
          assert.equal(actual, expected, `${id}: ${role}`);
        backgrounds.add(result.background);
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`theme-${id}`);
      }
      assert.equal(backgrounds.size, themes.length);
      await reloadPage();
      assert.equal(
        await evaluate(() => document.getElementById('factory-theme').value),
        'high-contrast',
      );
      await evaluate(() => {
        const select = document.getElementById('factory-theme');
        select.value = 'year1998';
        select.dispatchEvent(new Event('change', {bubbles: true}));
        const menu = document.getElementById('app-menu-panel');
        if (menu.matches(':popover-open')) menu.hidePopover();
        if (
          document
            .getElementById('motion-toggle')
            .getAttribute('aria-pressed') === 'true'
        )
          document.getElementById('motion-toggle').click();
      });
      hub.sessions[0].agents = [
        'running',
        'queued',
        'completed',
        'failed',
        'cancelling',
        'cancelled',
      ].map((status, index) => ({
        id: `retro-${index}`,
        name: `${status} agent`,
        status,
        task: 'Inspect workspace',
        activity: status,
        createdAt: at,
        startedAt: at,
        model: 'fixture/small',
      }));
      hub.sessions[0].totalAgents = 6;
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-canvas').dataset.renderer,
        ),
        'year1998',
      );
      await evaluate(() =>
        [...document.querySelectorAll('.scene-label')]
          .find(button => button.textContent === 'completed agent')
          .click(),
      );
      await settle();
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-title').textContent,
        ),
        'completed agent',
      );
      await evaluate(() =>
        document.querySelector('.scene-label.parent-label').click(),
      );
      for (const [width, height, zoom] of [
        [1600, 1000, 1],
        [1100, 760, 1.5],
        [1600, 1000, 2],
      ]) {
        window.setContentSize(width, height);
        await evaluate(zoom => {
          const control = document.getElementById('app-zoom');
          control.value = String(zoom);
          control.dispatchEvent(new Event('change', {bubbles: true}));
        }, zoom);
        await evaluate(
          expected => {
            window.fixtureViewport = expected;
          },
          {width: width / zoom, height: height / zoom},
        );
        await until(
          () =>
            Math.abs(innerWidth - window.fixtureViewport.width) < 2 &&
            Math.abs(innerHeight - window.fixtureViewport.height) < 2,
          'Year1998 window did not finish resizing',
        );
        await settle();
        const geometry = await evaluate(() => {
          const ids = [
            'factory-panel',
            'inspector',
            'scene',
            'parent-controls',
            'app-menu-button',
          ];
          const main = document.querySelector('main');
          return {
            scrolls:
              main.scrollHeight > main.clientHeight + 1 ||
              main.scrollWidth > main.clientWidth + 1,
            clipped: ids.filter(id => {
              const box = document.getElementById(id).getBoundingClientRect();
              return (
                box.width <= 0 ||
                box.height <= 0 ||
                box.left < 0 ||
                box.top < 0 ||
                box.right > innerWidth + 1 ||
                box.bottom > innerHeight + 1
              );
            }),
            scene: document.getElementById('scene').getBoundingClientRect()
              .height,
          };
        });
        assert.deepEqual(geometry.clipped, []);
        assert.equal(geometry.scrolls, false);
        assert.ok(
          geometry.scene >= 180,
          `Year1998 scene too small at ${width}x${height}/${zoom}: ${geometry.scene}`,
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`year1998-workspace-${width}-${zoom}`);
      }
      await reloadPage();
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-canvas').dataset.renderer,
        ),
        'year1998',
      );
      window.setContentSize(1600, 1000);
      await evaluate(() => {
        const zoom = document.getElementById('app-zoom');
        zoom.value = '1';
        zoom.dispatchEvent(new Event('change', {bubbles: true}));
        const select = document.getElementById('factory-theme');
        select.value = 'solarized-light';
        select.dispatchEvent(new Event('change', {bubbles: true}));
      });
      await settle();
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-canvas').dataset.renderer,
        ),
        'factory',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('light-theme');
    },
  );

  await run(
    'native zoom scales commands and the expanded editor and survives reload',
    async () => {
      await evaluate(() => {
        const zoom = document.getElementById('app-zoom');
        zoom.value = '1.5';
        zoom.dispatchEvent(new Event('change', {bubbles: true}));
      });
      await settle();
      assert.equal(window.webContents.getZoomFactor(), 1.5);
      const mainFont = await evaluate(() =>
        parseFloat(
          getComputedStyle(document.getElementById('parent-prompt')).fontSize,
        ),
      );
      assert.ok(mainFont >= 16);
      await evaluate(() => document.getElementById('open-commands').click());
      await until(
        () => !!document.querySelector('.command-description'),
        'Commands did not load',
      );
      assert.equal(
        await evaluate(() =>
          parseFloat(
            getComputedStyle(document.querySelector('.command-description'))
              .fontSize,
          ),
        ),
        mainFont,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('commands-zoomed');
      await evaluate(() => {
        document.getElementById('close-commands').click();
        document.getElementById('expand-parent-editor').click();
      });
      const expanded = await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        const bounds = editor.getBoundingClientRect();
        const form = document
          .getElementById('prompt-form')
          .getBoundingClientRect();
        return {
          font: parseFloat(getComputedStyle(editor).fontSize),
          fills: bounds.height > innerHeight * 0.5,
          fillsWidth:
            Math.abs(bounds.left - form.left) <= 1 &&
            Math.abs(bounds.right - form.right) <= 1,
          fits:
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight &&
            bounds.right <= innerWidth,
          open: document
            .getElementById('parent-controls')
            .matches(':popover-open'),
          hints: /Enter sends|Shift\+Enter adds a line/.test(
            document.getElementById('parent-controls').textContent,
          ),
        };
      });
      assert.deepEqual(expanded, {
        font: mainFont,
        fills: true,
        fillsWidth: true,
        fits: true,
        open: true,
        hints: false,
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('editor-zoomed');
      await evaluate(() => document.getElementById('open-commands').click());
      assert.equal(
        await evaluate(() => {
          const dialog = document.getElementById('commands-dialog');
          return (
            dialog.matches(':modal') &&
            !dialog.inert &&
            document.activeElement === document.getElementById('command-search')
          );
        }),
        true,
      );
      await evaluate(() => {
        document.getElementById('close-commands').click();
        document.getElementById('expand-parent-editor').click();
      });
      await reloadPage();
      assert.equal(window.webContents.getZoomFactor(), 1.5);
      // The View menu changes native page zoom, which the setting must also save.
      window.webContents.setZoomFactor(1.25);
      await until(
        () =>
          Math.abs(
            Number(window.localStorage.getItem('varisdev.factory.zoom')) - 1.25,
          ) < 0.001,
        'Native zoom was not persisted',
      );
      await reloadPage();
      assert.ok(Math.abs(window.webContents.getZoomFactor() - 1.25) < 0.001);
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('workspace-zoomed');
    },
  );

  await run(
    'steering stays visible until delivery or Stop and belongs to its parent',
    async () => {
      assert.equal(
        await evaluate(
          () => document.getElementById('send-prompt').textContent,
        ),
        'Steer',
      );
      for (let index = 0; index < 2; index++) {
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          editor.value = 'Please inspect the tests first.';
          editor.dispatchEvent(new Event('input', {bubbles: true}));
          document.getElementById('prompt-form').requestSubmit();
        });
        await until(
          () =>
            !document.getElementById('send-prompt').disabled &&
            document.getElementById('parent-prompt').value === '',
          'Submission did not finish',
        );
      }
      assert.deepEqual(
        await evaluate(() =>
          [...document.querySelectorAll('#steering-message-list pre')].map(
            item => item.textContent,
          ),
        ),
        ['Please inspect the tests first.', 'Please inspect the tests first.'],
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('steering-messages').hidden,
        ),
        false,
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'prompt'),
        [
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: 'Please inspect the tests first.'},
          },
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: 'Please inspect the tests first.'},
          },
        ],
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click(),
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('steering-messages').hidden,
        ),
        true,
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Alpha'))
          .click(),
      );
      await reloadPage();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#steering-message-list li').length,
        ),
        2,
      );
      hub.sessions[0].queue.steering.shift();
      hub.sessions[0].conversation.push({
        id: 'delivered',
        role: 'user',
        text: 'Please inspect the tests first.',
        at,
      });
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#steering-message-list li').length,
        ),
        1,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) await screenshot('steering');
      hub.sessions[0].queue.steering = Array(6).fill('Steering instruction');
      await publish();
      window.webContents.setZoomFactor(1.5);
      await settle();
      assert.equal(
        await evaluate(() => {
          const send = document
            .getElementById('send-prompt')
            .getBoundingClientRect();
          const queue = document.getElementById('steering-messages');
          return (
            send.bottom <= innerHeight &&
            queue.scrollHeight > queue.clientHeight
          );
        }),
        true,
        'Steering messages must stay accessible without hiding Steer at 150% zoom',
      );
      await evaluate(() => document.getElementById('abort-parent').click());
      await until(
        () => document.getElementById('steering-messages').hidden,
        'Stop did not clear pending steering',
      );
      assert.equal(
        await evaluate(
          () =>
            [...document.querySelectorAll('#conversation .user')].filter(item =>
              item.textContent.includes('Please inspect the tests first.'),
            ).length,
        ),
        1,
      );
      hub.sessions[0].session.status = 'idle';
      await publish();
      assert.equal(
        await evaluate(
          () => document.getElementById('send-prompt').textContent,
        ),
        'Send',
      );
    },
  );

  await run(
    'Stop and Escape restore queued steering in order with drafts and isolate delayed parent switches',
    async () => {
      const parent = hub.sessions[0];
      parent.queue.steering = [
        'First steering',
        'Second steering\nwith details',
      ];
      await publish();
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Existing draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('abort-parent').click();
      });
      await until(
        () =>
          !document.getElementById('abort-parent').disabled ||
          document
            .getElementById('parent-prompt')
            .value.includes('First steering'),
        'Stop did not restore queued messages',
      );
      const restored =
        'First steering\n\nSecond steering\nwith details\n\nExisting draft';
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        restored,
      );
      assert.deepEqual(parent.queue.steering, []);
      await publish();
      await publish();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        restored,
        'Repeated cleared snapshots cannot duplicate restored steering',
      );
      parent.queue.steering = ['Escape steering'];
      await publish();
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'New draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.focus();
      });
      await press('Escape');
      await until(
        () =>
          document.getElementById('parent-prompt').value ===
          'Escape steering\n\nNew draft',
        'Escape did not restore queued messages',
      );
      parent.queue.steering = ['Delayed steering'];
      abortDelay = 150;
      await publish();
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Alpha before delay';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('abort-parent').click();
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta'))
          .click();
        editor.value = 'Beta draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await new Promise(resolve => setTimeout(resolve, 220));
      await settle();
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Beta draft',
      );
      assert.equal(
        await evaluate(
          () =>
            JSON.parse(
              window.localStorage.getItem('varisdev.composer-drafts.v1'),
            ).find(([id]) => id === 'alpha')?.[1].value,
        ),
        'Delayed steering\n\nAlpha before delay',
        'Recovered steering persists while another parent is selected',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Alpha'))
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Delayed steering\n\nAlpha before delay',
      );
      assert.equal(calls.filter(call => call.method === 'abort').length, 3);
    },
  );

  await run(
    'pinned Markdown stays beside a reachable parent composer and supports movement and Lock',
    async () => {
      await evaluate(async () => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Draft while following agents';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        const {openMarkdownFile} = await import('./markdown-files.js');
        await openMarkdownFile('/fixture/PLAN.md', {pin: true});
      });
      await until(
        () =>
          document
            .getElementById('markdown-preview')
            .textContent.includes('Finish UI'),
        'Pinned task file did not load',
      );
      const geometry = await evaluate(() => {
        const panel = document
          .getElementById('markdown-panel')
          .getBoundingClientRect();
        const editor = document.getElementById('parent-prompt');
        const rect = editor.getBoundingClientRect();
        const button = document.getElementById('send-prompt');
        const send = button.getBoundingClientRect();
        return {
          panelHidden: document.getElementById('markdown-panel').hidden,
          panelEndsBeforeComposer: panel.right < rect.left,
          editorReachable:
            document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            ) === editor,
          sendReachable:
            document.elementFromPoint(
              send.left + send.width / 2,
              send.top + send.height / 2,
            ) === button,
          draft: editor.value,
          tasks: document.querySelectorAll(
            '#markdown-preview input[type="checkbox"]',
          ).length,
        };
      });
      assert.deepEqual(geometry, {
        panelHidden: false,
        panelEndsBeforeComposer: true,
        editorReachable: true,
        sendReachable: true,
        draft: 'Draft while following agents',
        tasks: 2,
      });
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('markdown-beside-parent');
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.focus();
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'Parent composer cannot send while pinned file is visible',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'prompt'),
        [
          {
            method: 'prompt',
            sessionId: 'alpha',
            request: {prompt: 'Draft while following agents'},
          },
        ],
      );
      const placement = await evaluate(() => {
        const panel = document.getElementById('markdown-panel');
        const heading = document.getElementById('markdown-heading');
        const before = panel.getBoundingClientRect().left;
        heading.focus();
        heading.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            shiftKey: true,
            bubbles: true,
          }),
        );
        const moved = panel.getBoundingClientRect().left;
        document.getElementById('markdown-lock').click();
        heading.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            shiftKey: true,
            bubbles: true,
          }),
        );
        const locked = panel.getBoundingClientRect().left;
        const lockVisible =
          document.getElementById('markdown-lock').textContent === 'Unlock';
        const resizeLocked =
          document.getElementById('markdown-resize').disabled;
        document.getElementById('markdown-lock').click();
        heading.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            shiftKey: true,
            bubbles: true,
          }),
        );
        return {
          before,
          moved,
          locked,
          lockVisible,
          resizeLocked,
          restored: panel.getBoundingClientRect().left,
        };
      });
      assert.ok(
        Math.abs(placement.moved - placement.before - 40) < 0.1,
        'Keyboard moves panel freely',
      );
      assert.equal(
        placement.locked,
        placement.moved,
        'Lock fixes panel position',
      );
      assert.equal(placement.lockVisible, true, 'Lock state is visible');
      assert.equal(placement.resizeLocked, true, 'Lock also disables resize');
      assert.ok(
        Math.abs(placement.restored - placement.before) < 0.1,
        'Unlock permits moving back',
      );
      const preferred = await evaluate(() =>
        JSON.parse(
          window.localStorage.getItem('varisdev.markdown-placement.v1'),
        ),
      );
      window.setContentSize(1100, 760);
      window.webContents.setZoomFactor(1.5);
      await until(() => {
        const panel = document
          .getElementById('markdown-panel')
          .getBoundingClientRect();
        return (
          Math.abs(innerWidth - 1100 / 1.5) <= 1 &&
          Math.abs(innerHeight - 760 / 1.5) <= 1 &&
          panel.left >= 8 &&
          panel.top >= 8 &&
          panel.right <= innerWidth - 8 &&
          panel.bottom <= innerHeight - 8
        );
      }, 'Pinned Markdown placement did not settle inside the zoomed viewport');
      const compact = await evaluate(() => {
        const panel = document
          .getElementById('markdown-panel')
          .getBoundingClientRect();
        const preview = document
          .getElementById('markdown-preview')
          .getBoundingClientRect();
        const editor = document.getElementById('parent-prompt');
        const send = document.getElementById('send-prompt');
        const reachable = element => {
          const box = element.getBoundingClientRect();
          return (
            box.bottom <= innerHeight &&
            document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            ) === element
          );
        };
        const rect = element => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          };
        };
        return {
          panel: {
            left: panel.left,
            top: panel.top,
            right: panel.right,
            bottom: panel.bottom,
          },
          preview: {
            top: preview.top,
            bottom: preview.bottom,
            height: preview.height,
          },
          viewport: {width: innerWidth, height: innerHeight},
          editor: rect(editor),
          send: rect(send),
          editorReachable: reachable(editor),
          sendReachable: reachable(send),
        };
      });
      assert.equal(
        compact.editorReachable,
        true,
        `Composer reachable at 1100px and 150% zoom: ${JSON.stringify(compact)}`,
      );
      assert.equal(
        compact.sendReachable,
        true,
        `Send reachable at 1100px and 150% zoom: ${JSON.stringify(compact)}`,
      );
      assert.ok(
        compact.panel.left >= 8 &&
          compact.panel.top >= 8 &&
          compact.panel.right <= compact.viewport.width - 8 &&
          compact.panel.bottom <= compact.viewport.height - 8,
        `Panel remains inside zoomed viewport: ${JSON.stringify(compact)}`,
      );
      assert.ok(
        compact.preview.height >= 60 &&
          compact.preview.bottom <= compact.panel.bottom,
        `File remains readable at 150% zoom: ${JSON.stringify(compact)}`,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('markdown-zoomed');
      window.webContents.setZoomFactor(1);
      window.setContentSize(1600, 1000);
      await settle();
      const restored = await evaluate(() => {
        const box = document
          .getElementById('markdown-panel')
          .getBoundingClientRect();
        return {x: box.left, y: box.top, width: box.width, height: box.height};
      });
      assert.ok(
        Object.keys(restored).every(
          key => Math.abs(restored[key] - preferred[key]) < 0.1,
        ),
        `Zoom restores saved placement and size: ${JSON.stringify({restored, preferred})}`,
      );
      await evaluate(() => document.getElementById('markdown-close').click());
    },
  );

  await run(
    'New session closes the selected parent before creating in its folder',
    async () => {
      const currentFolder = join(directory, 'selected-parent-folder');
      hub.sessions[0].session.cwd = currentFolder;
      hub.sessions[0].agents = [
        {
          id: 'new-session-agent',
          name: 'New session agent',
          task: 'Keep working in the original parent',
          activity: 'Inspecting the project',
          model: 'fixture/small',
          status: 'running',
          createdAt: at,
          startedAt: at,
        },
      ];
      hub.sessions[0].totalAgents = 1;
      creationIds = ['fresh-parent'];
      creationDelay = 180;
      await publish();
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Keep this draft in the working parent';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.setSelectionRange(5, 15);
        document.querySelector('#active-workers button').click();
        document.getElementById('app-menu-button').click();
      });
      assert.deepEqual(
        await evaluate(() => ({
          inspector: document.getElementById('inspector-title').textContent,
          startHidden: document.getElementById('start-session').hidden,
          closeHidden: document.getElementById('close-session').hidden,
          start: document.getElementById('start-session').textContent,
          openFolder: document.getElementById('new-session').textContent.trim(),
        })),
        {
          inspector: 'New session agent',
          startHidden: true,
          closeHidden: false,
          start: 'Reset conversation',
          openFolder: 'Open folder',
        },
        'Replacement action is hidden while a spawned agent is selected',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('session-menu');
      await evaluate(() => {
        document.getElementById('back-to-parent').click();
        const action = document.getElementById('start-session');
        action.click();
        action.click();
      });
      await until(
        () =>
          document.getElementById('start-session').textContent === 'Creating…',
        'New session did not enter its pending state',
      );
      assert.deepEqual(
        await evaluate(() => ({
          disabled: document.getElementById('start-session').disabled,
          label: document.getElementById('start-session').textContent,
          menuOpen: document
            .getElementById('app-menu-panel')
            .matches(':popover-open'),
        })),
        {disabled: true, label: 'Creating…', menuOpen: false},
      );
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        'Fresh session was not selected',
      );
      assert.deepEqual(
        calls.filter(call =>
          ['chooseFolder', 'closeSession', 'createSession'].includes(
            call.method,
          ),
        ),
        [
          {method: 'closeSession', sessionId: 'alpha'},
          {
            method: 'createSession',
            input: {cwd: currentFolder},
          },
        ],
        'New session creates once in the selected parent folder without a picker',
      );
      assert.deepEqual(
        await evaluate(() => ({
          editor: document.getElementById('parent-prompt').value,
          messages: document.querySelectorAll('#conversation > li').length,
          focused:
            document.activeElement === document.getElementById('parent-prompt'),
          parents: [
            ...document.querySelectorAll('#parents .parent-card-name'),
          ].map(item => item.textContent),
        })),
        {
          editor: '',
          messages: 0,
          focused: true,
          parents: ['Beta factory', 'Selected folder'],
        },
        'The fresh session replaces the selected parent and leaves other parents open',
      );
      assert.equal(
        hub.sessions.some(item => item.session.id === 'alpha'),
        false,
      );
      assert.ok(archivedSessions.has('alpha'));
    },
  );

  await run(
    'session action failures coalesce while pending and allow retry',
    async () => {
      creationIds = ['retry-parent'];
      creationDelay = 180;
      creationError = 'Could not create the session';
      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        const action = document.getElementById('start-session');
        action.click();
        action.click();
      });
      await until(
        () =>
          document.getElementById('start-session').textContent === 'Creating…',
        'Create failure case did not enter its pending state',
      );
      assert.deepEqual(
        await evaluate(() => ({
          disabled: document.getElementById('start-session').disabled,
          menuOpen: document
            .getElementById('app-menu-panel')
            .matches(':popover-open'),
        })),
        {disabled: true, menuOpen: false},
      );
      await until(
        () => !document.getElementById('app-error').hidden,
        'Create failure was not shown',
      );
      assert.match(
        await evaluate(() => document.getElementById('app-error').textContent),
        /Could not create the session/,
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession'),
        [{method: 'createSession', input: {cwd: directory}}],
        'Repeated create clicks must share one request',
      );
      assert.deepEqual(
        await evaluate(() => ({
          disabled: document.getElementById('start-session').disabled,
          label: document.getElementById('start-session').textContent,
        })),
        {disabled: false, label: 'Retry reset conversation'},
      );

      creationDelay = 0;
      creationError = undefined;
      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('start-session').click();
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        'Create retry did not select the fresh session',
      );
      assert.equal(
        await evaluate(() => document.getElementById('app-error').hidden),
        true,
        'Retry clears the previous creation error',
      );
      assert.equal(
        calls.filter(call => call.method === 'createSession').length,
        2,
      );

      closeDelay = 180;
      closeError = 'Could not close the session';
      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('close-session').click();
        document.getElementById('close-parent-session').click();
      });
      await until(
        () =>
          document.getElementById('close-session').textContent === 'Closing…',
        'Close failure case did not enter its pending state',
      );
      assert.deepEqual(
        await evaluate(() => ({
          disabled: document.getElementById('close-session').disabled,
          headingDisabled: document.getElementById('close-parent-session')
            .disabled,
          headingLabel: document.getElementById('close-parent-session')
            .textContent,
          menuOpen: document
            .getElementById('app-menu-panel')
            .matches(':popover-open'),
        })),
        {
          disabled: true,
          headingDisabled: true,
          headingLabel: 'Closing…',
          menuOpen: false,
        },
      );
      await until(
        () => !document.getElementById('app-error').hidden,
        'Close failure was not shown',
      );
      assert.match(
        await evaluate(() => document.getElementById('app-error').textContent),
        /Could not close the session/,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-title').textContent,
        ),
        'Selected folder',
        'A failed close keeps the selected parent open',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'closeSession'),
        [
          {method: 'closeSession', sessionId: 'alpha'},
          {method: 'closeSession', sessionId: 'retry-parent'},
        ],
        'Repeated close clicks must share one request',
      );
      assert.deepEqual(
        await evaluate(() => ({
          disabled: document.getElementById('close-session').disabled,
          headingDisabled: document.getElementById('close-parent-session')
            .disabled,
          label: document.getElementById('close-session').textContent,
        })),
        {disabled: false, headingDisabled: false, label: 'Close workspace'},
      );

      closeDelay = 0;
      closeError = undefined;
      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('close-session').click();
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Beta factory',
        'Close retry did not select a remaining parent',
      );
      assert.equal(
        calls.filter(call => call.method === 'closeSession').length,
        3,
      );
      assert.equal(
        await evaluate(() => document.getElementById('app-error').hidden),
        true,
        'Retry clears the previous close error',
      );
      // Even after the final parent closes, a failed replacement can be retried
      // in its original folder rather than the launch folder.
      const lastFolder = join(directory, 'last-parent-folder');
      hub.sessions[0].session.cwd = lastFolder;
      creationIds = ['last-replacement'];
      creationError = 'Could not create the replacement';
      await publish();
      await evaluate(() => document.getElementById('start-session').click());
      await until(
        () =>
          !document.getElementById('welcome').hidden &&
          !document.getElementById('app-error').hidden,
        'Replacement failure did not reach welcome',
      );
      assert.deepEqual(
        await evaluate(() => ({
          hidden: document.getElementById('start-session').hidden,
          disabled: document.getElementById('start-session').disabled,
          label: document.getElementById('start-session').textContent,
        })),
        {hidden: false, disabled: false, label: 'Retry reset conversation'},
      );
      assert.deepEqual(calls.slice(-2), [
        {method: 'closeSession', sessionId: 'beta'},
        {method: 'createSession', input: {cwd: lastFolder}},
      ]);
      creationError = undefined;
      await evaluate(() => document.getElementById('start-session').click());
      await until(
        () => !document.getElementById('factory-workspace').hidden,
        'Retry did not leave welcome',
      );
      assert.deepEqual(calls.at(-1), {
        method: 'createSession',
        input: {cwd: lastFolder},
      });
      assert.deepEqual(
        hub.sessions.map(item => item.session.id),
        ['last-replacement'],
      );
    },
  );

  await run(
    '/new starts a fresh session in the current folder without contacting the model',
    async () => {
      const cwd = join(directory, 'new-command-project');
      hub.sessions[0].session.cwd = cwd;
      hub.sessions[0].session.model = undefined;
      hub.sessions[0].agents = [
        {
          id: 'working-agent',
          name: 'Working agent',
          task: 'Continue working',
          status: 'running',
          startedAt: at,
          createdAt: at,
        },
      ];
      resources.set('alpha', {...features(), model: undefined, models: []});
      creationIds = ['command-parent'];
      creationDelay = 180;
      await publish();
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/ne';
        editor.focus();
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await until(
        () =>
          !document.getElementById('command-suggestions').hidden &&
          document
            .getElementById('command-suggestions')
            .textContent.includes('/new'),
        '/new must appear in slash suggestions without a selected model',
      );
      await press('Return');
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '/new ',
      );
      assert.deepEqual(
        calls,
        [],
        'Accepting a suggestion only edits the draft',
      );
      await press('Return');
      await until(
        () =>
          document.getElementById('start-session').textContent === 'Creating…',
        '/new did not start session creation',
      );
      await evaluate(() =>
        document.getElementById('prompt-form').requestSubmit(),
      );
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        '/new did not select the fresh parent',
      );
      assert.deepEqual(calls, [
        {method: 'closeSession', sessionId: 'alpha'},
        {method: 'createSession', input: {cwd}},
      ]);
      const fresh = hub.sessions.find(
        item => item.session.id === 'command-parent',
      );
      assert.deepEqual(fresh.conversation, []);
      assert.equal(fresh.session.status, 'idle');
      assert.equal(
        hub.sessions.some(item => item.session.id === 'alpha'),
        false,
      );
      assert.ok(archivedSessions.has('alpha'));
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '',
      );

      assert.equal(
        await evaluate(() => {
          const saved = JSON.parse(
            window.localStorage.getItem('varisdev.composer-drafts.v1') || '[]',
          );
          return saved.some(([id]) => id === 'alpha');
        }),
        false,
        'A successful /new must clear its submitted draft',
      );
    },
  );

  await run(
    '/new validates arguments, preserves failed or edited drafts, and allows retry',
    async () => {
      closeError = 'Could not close the current session.';
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/new extra';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => !document.getElementById('prompt-error').hidden,
        '/new with arguments must report its usage',
      );
      assert.match(
        await evaluate(
          () => document.getElementById('prompt-error').textContent,
        ),
        /Usage: \/new/,
      );
      assert.deepEqual(calls, []);
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '  /new  ';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => !document.getElementById('app-error').hidden,
        'Session close failure must be visible',
      );
      assert.match(
        await evaluate(() => document.getElementById('app-error').textContent),
        /Could not close the current session/,
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        '  /new  ',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('factory-title').textContent,
        ),
        'Alpha factory',
      );
      assert.deepEqual(calls, [{method: 'closeSession', sessionId: 'alpha'}]);
      closeError = undefined;
      creationDelay = 180;
      creationIds = ['retry-command-parent'];
      await evaluate(() => {
        document.getElementById('prompt-form').requestSubmit();
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Keep this edited draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta factory'))
          .click();
        editor.value = 'Keep the other draft';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        '/new retry must select the fresh parent',
      );
      assert.deepEqual(calls, [
        {method: 'closeSession', sessionId: 'alpha'},
        {method: 'closeSession', sessionId: 'alpha'},
        {method: 'createSession', input: {cwd: directory}},
      ]);
      assert.equal(
        hub.sessions.some(item => item.session.id === 'alpha'),
        false,
      );
      assert.equal(
        await evaluate(
          () =>
            JSON.parse(
              localStorage.getItem('varisdev.composer-drafts.v1'),
            ).find(([id]) => id === 'alpha')?.[1].value,
        ),
        'Keep this edited draft',
      );
      await evaluate(() =>
        [...document.querySelectorAll('#parents button')]
          .find(button => button.textContent.includes('Beta factory'))
          .click(),
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-prompt').value),
        'Keep the other draft',
      );
      await evaluate(() => {
        const editor = document.getElementById('parent-prompt');
        editor.value = '/newspaper';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
      });
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'A different command name must follow normal prompt handling',
      );
      assert.deepEqual(calls.at(-1), {
        method: 'prompt',
        sessionId: 'beta',
        request: {prompt: '/newspaper'},
      });
    },
  );

  await run(
    'Close session falls back and reaches welcome while preserving draft and history',
    async () => {
      hub.sessions[0].agents = [
        {
          id: 'close-session-agent',
          name: 'Close session agent',
          task: 'Keep working until the parent closes',
          activity: 'Running in the active parent',
          model: 'fixture/small',
          status: 'running',
          createdAt: at,
          startedAt: at,
        },
      ];
      hub.sessions[0].totalAgents = 1;
      await publish();
      assert.equal(
        await evaluate(() =>
          document.getElementById('close-parent-session').checkVisibility(),
        ),
        true,
        'Close session must be directly accessible in the live panel',
      );
      await evaluate(async () => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Resume this draft after closing';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.setSelectionRange(7, 18);
        editor.dispatchEvent(new Event('select', {bubbles: true}));
        const {flushDrafts} = await import('./draft-storage.js');
        flushDrafts();
        document.querySelector('#active-workers button').click();
        document.getElementById('back-to-parent').click();
        document.getElementById('close-parent-session').click();
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Beta factory',
        'Closing the active parent did not select the remaining parent',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'closeSession'),
        [{method: 'closeSession', sessionId: 'alpha'}],
      );
      assert.deepEqual(
        await evaluate(() => ({
          menuOpen: document
            .getElementById('app-menu-panel')
            .matches(':popover-open'),
          parents: [
            ...document.querySelectorAll('#parents .parent-card-name'),
          ].map(item => item.textContent),
          draft: JSON.parse(
            window.localStorage.getItem('varisdev.composer-drafts.v1'),
          ).find(([id]) => id === 'alpha')?.[1]?.value,
        })),
        {
          menuOpen: false,
          parents: ['Beta factory'],
          draft: 'Resume this draft after closing',
        },
        'Closing removes only the live parent and keeps its recovered draft',
      );

      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('resume-session').click();
      });
      await until(
        () =>
          document.querySelectorAll('#session-history-list button').length ===
          2,
        'Closed parent did not remain in session history',
      );
      assert.match(
        await evaluate(
          () => document.getElementById('session-history-list').textContent,
        ),
        /Alpha factory.*3 messages/s,
      );
      await evaluate(() =>
        [...document.querySelectorAll('#session-history-list button')]
          .find(item => item.textContent.includes('Alpha factory'))
          .click(),
      );
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Alpha factory',
        'Closed parent did not reopen from history',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession'),
        [
          {
            method: 'createSession',
            input: {cwd: directory, sessionId: 'alpha'},
          },
        ],
      );
      assert.deepEqual(
        await evaluate(() => {
          const editor = document.getElementById('parent-prompt');
          return {
            history: document
              .getElementById('conversation')
              .textContent.includes('I will inspect the project.'),
            draft: editor.value,
            start: editor.selectionStart,
            end: editor.selectionEnd,
          };
        }),
        {
          history: true,
          draft: 'Resume this draft after closing',
          start: 7,
          end: 18,
        },
        'Reopening restores conversation history and its unsent draft',
      );

      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('close-session').click();
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Beta factory',
        'Reopened parent did not fall back to the other parent',
      );
      await evaluate(() => {
        document.getElementById('open-commands').click();
        document.getElementById('close-parent-session').click();
      });
      await until(
        () => !document.getElementById('welcome').hidden,
        'Closing the final parent did not show welcome',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'closeSession'),
        [
          {method: 'closeSession', sessionId: 'alpha'},
          {method: 'closeSession', sessionId: 'alpha'},
          {method: 'closeSession', sessionId: 'beta'},
        ],
      );
      await evaluate(() => document.getElementById('app-menu-button').click());
      assert.deepEqual(
        await evaluate(() => ({
          welcome: !document.getElementById('welcome').hidden,
          workspace: document.getElementById('factory-workspace').hidden,
          startHidden: document.getElementById('start-session').hidden,
          closeHidden: document.getElementById('close-session').hidden,
          commandsOpen: document.getElementById('commands-dialog').open,
          settingsDisabled: document.getElementById('open-session-settings')
            .disabled,
          openFolder: document.getElementById('new-session').textContent.trim(),
        })),
        {
          welcome: true,
          workspace: true,
          startHidden: true,
          closeHidden: true,
          commandsOpen: false,
          settingsDisabled: true,
          openFolder: 'Open folder',
        },
        'Parent-only actions are hidden when no parent remains',
      );
    },
  );

  await run(
    'Resume session lists folder history and opens the selected conversation',
    async () => {
      await evaluate(() => {
        document.getElementById('app-menu-button').click();
        document.getElementById('resume-session').click();
      });
      await until(
        () =>
          document.querySelectorAll('#session-history-list button').length ===
          1,
        'Saved session did not appear',
      );
      assert.equal(
        await evaluate(() =>
          document.getElementById('app-menu-panel').matches(':popover-open'),
        ),
        false,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('session-history-folder').textContent,
        ),
        directory,
      );
      assert.deepEqual(calls, [{method: 'listSessions', cwd: directory}]);
      assert.match(
        await evaluate(
          () => document.getElementById('session-history-list').textContent,
        ),
        /Saved conversation.*2 messages/s,
      );
      await evaluate(() =>
        document.getElementById('session-history-choose').click(),
      );
      await until(
        () => !document.getElementById('session-history-choose').disabled,
        'Cancelled folder picker stayed busy',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelectorAll('#session-history-list button').length,
        ),
        1,
      );
      chosenFolder = join(directory, 'empty');
      await evaluate(() =>
        document.getElementById('session-history-choose').click(),
      );
      await until(
        () =>
          document.getElementById('session-history-status').textContent ===
          'No saved sessions in this folder.',
        'Empty folder not shown',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelectorAll('#session-history-list button').length,
        ),
        0,
      );
      chosenFolder = directory;
      await evaluate(() =>
        document.getElementById('session-history-choose').click(),
      );
      await until(
        () =>
          document.querySelectorAll('#session-history-list button').length ===
          1,
        'Folder history did not reload',
      );
      resumeError = 'Saved session unavailable';
      await evaluate(() =>
        document.querySelector('#session-history-list button').click(),
      );
      await until(
        () => !document.getElementById('session-history-error').hidden,
        'Resume failure not shown',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('session-history-dialog').open,
        ),
        true,
      );
      resumeError = undefined;
      await evaluate(() => {
        const button = document.querySelector('#session-history-list button');
        button.click();
        button.click();
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Saved conversation',
        'Resumed session was not selected',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession'),
        [
          {
            method: 'createSession',
            input: {cwd: directory, sessionId: 'saved-parent'},
          },
          {
            method: 'createSession',
            input: {cwd: directory, sessionId: 'saved-parent'},
          },
        ],
      );
      assert.deepEqual(
        await evaluate(() => ({
          open: document.getElementById('session-history-dialog').open,
          history: document
            .getElementById('conversation')
            .textContent.includes('I will inspect the project.'),
          focused:
            document.activeElement === document.getElementById('parent-prompt'),
        })),
        {open: false, history: true, focused: true},
      );
      assert.ok(!calls.some(call => call.method === 'prompt'));
    },
  );

  await run(
    'Welcome shows recent projects and opens them without a folder picker',
    async () => {
      hub.sessions = [];
      hub.selectedSessionId = undefined;
      window.webContents.send('fixture:snapshot', hub);
      await until(
        () =>
          !document.getElementById('welcome').hidden &&
          document.querySelectorAll('#recent-projects-list button').length ===
            2,
        'Recent projects did not appear on the start screen',
      );
      const folders = await evaluate(() =>
        [...document.querySelectorAll('#recent-projects-list button span')].map(
          item => item.textContent,
        ),
      );
      assert.deepEqual(folders, [directory, join(directory, 'other-project')]);
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('recent-projects');
      assert.equal(
        await evaluate(
          () => document.querySelector('#recent-projects-list button').disabled,
        ),
        false,
      );
      creationError = 'Project folder is unavailable';
      await evaluate(() =>
        document.querySelector('#recent-projects-list button').click(),
      );
      await until(
        () =>
          !document.getElementById('app-error').hidden &&
          !document.querySelector('#recent-projects-list button').disabled,
        'Failed recent project did not allow retry',
      );
      assert.equal(
        await evaluate(() => document.getElementById('welcome').hidden),
        false,
      );
      creationError = undefined;
      creationDelay = 200;
      await evaluate(() => {
        const button = document.querySelector('#recent-projects-list button');
        button.click();
        button.click();
      });
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        'Recent project was not opened',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession'),
        [
          {method: 'createSession', input: {cwd: directory}},
          {method: 'createSession', input: {cwd: directory}},
        ],
      );
      assert.equal(
        calls.some(call => call.method === 'chooseFolder'),
        false,
      );
      assert.equal(
        await evaluate(() => document.getElementById('welcome').hidden),
        true,
      );
      // Simulate projects opened through a second app instance rather than a
      // renderer action. Returning home must fetch the newly saved history.
      recentProjects = Array.from({length: 12}, (_, i) =>
        join(directory, `external-project-${i}`),
      );
      hub.sessions = [];
      window.webContents.send('fixture:snapshot', hub);
      await until(
        () =>
          document.querySelectorAll('#recent-projects-list button').length ===
          12,
        'Returning to welcome did not refresh external project history',
      );
      assert.equal(
        await evaluate(
          () =>
            document.querySelector('#recent-projects-list strong').textContent,
        ),
        'external-project-0',
      );
      window.setContentSize(1100, 760);
      window.webContents.setZoomFactor(1.75);
      await settle();
      const layout = await evaluate(() => ({
        headingTop: document
          .getElementById('welcome-title')
          .getBoundingClientRect().top,
        panelTop: document.getElementById('welcome').getBoundingClientRect()
          .top,
      }));
      assert.ok(
        layout.headingTop >= layout.panelTop,
        'The welcome heading remains reachable with twelve projects at high zoom',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('recent-projects-zoom');
    },
  );

  await run(
    'Open folder creates an idle conversation and the first prompt wakes its parent',
    async () => {
      await evaluate(() => document.getElementById('new-session').click());
      await until(
        () => !document.getElementById('new-session').disabled,
        'Cancelled picker remained busy',
      );
      assert.deepEqual(calls, [{method: 'chooseFolder'}]);
      chosenFolder = directory;
      await evaluate(() => document.getElementById('new-session').click());
      await until(
        () =>
          document.getElementById('factory-title').textContent ===
          'Selected folder',
        'Opened folder was not selected',
      );
      assert.deepEqual(calls.slice(1), [
        {method: 'chooseFolder'},
        {method: 'createSession', input: {cwd: directory}},
      ]);
      assert.deepEqual(
        await evaluate(() => ({
          editor: document.getElementById('parent-prompt').value,
          messages: document.querySelectorAll('#conversation > li').length,
          dialog: !!document.getElementById('create-dialog'),
          focused:
            document.activeElement === document.getElementById('parent-prompt'),
        })),
        {editor: '', messages: 0, dialog: false, focused: true},
      );
      const mode = await evaluate(async () => {
        const editor = document.getElementById('parent-prompt');
        editor.value = 'Inspect this project';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        document.getElementById('prompt-form').requestSubmit();
        await Promise.resolve();
        return document.getElementById('factory-canvas').dataset.parentMode;
      });
      assert.equal(mode, 'startled', 'The prompt wakes the parent immediately');
      await until(
        () => document.getElementById('parent-prompt').value === '',
        'The animation must allow the prompt to submit immediately',
      );
      assert.deepEqual(calls.at(-1), {
        method: 'prompt',
        sessionId: 'folder-parent',
        request: {prompt: 'Inspect this project'},
      });
    },
  );

  await run(
    'New conversation recent workspaces reload agents and preserve creation workflow',
    async () => {
      const other = join(directory, 'other-project');
      workspaceTemplateResponses.set(other, {
        templates: [
          {id: 'writer', name: 'Workspace writer', scope: 'workspace'},
        ],
        defaultAgentId: 'writer',
      });
      const click = id =>
        evaluate(id => document.getElementById(id).click(), id);
      await click('open-new-agent');
      await until(
        () => !document.getElementById('new-agent-recent').disabled,
        'Recent workspace suggestions did not load',
      );
      assert.deepEqual(
        await evaluate(() =>
          [...document.getElementById('new-agent-recent').options]
            .slice(1)
            .map(option => option.value),
        ),
        [directory, other],
      );
      await evaluate(other => {
        document.getElementById('new-agent-name').value =
          'Review the workspace';
        document.getElementById('new-agent-task').value = 'Inspect its files';
        const recent = document.getElementById('new-agent-recent');
        recent.value = other;
        recent.dispatchEvent(new Event('change'));
      }, other);
      await until(
        () => document.getElementById('new-agent-template').value === 'writer',
        'Selected workspace agent default did not load',
      );
      assert.deepEqual(
        await evaluate(() => ({
          folder: document.getElementById('new-agent-folder').textContent,
          name: document.getElementById('new-agent-name').value,
          task: document.getElementById('new-agent-task').value,
        })),
        {
          folder: other,
          name: 'Review the workspace',
          task: 'Inspect its files',
        },
      );
      for (const [width, height, zoom] of [
        [1600, 1000, 1],
        [1100, 760, 1.5],
      ]) {
        window.setContentSize(width, height);
        window.webContents.setZoomFactor(zoom);
        await settle();
        assert.equal(
          await evaluate(() => {
            const recent = document.getElementById('new-agent-recent');
            const rect = recent.getBoundingClientRect();
            const create = document
              .getElementById('new-agent-create')
              .getBoundingClientRect();
            return (
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) === recent &&
              create.bottom <= innerHeight &&
              document.documentElement.scrollHeight <= innerHeight
            );
          }),
          true,
          'Recent workspace selector and create action remain accessible',
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`new-conversation-recents-${width}-${zoom}`);
      }
      creationDelay = 150;
      dialogErrors.set(
        'promptSession',
        'Initial message temporarily unavailable',
      );
      await click('new-agent-create');
      assert.equal(
        await evaluate(
          () => document.getElementById('new-agent-recent').disabled,
        ),
        true,
      );
      await until(
        () =>
          !document.getElementById('new-agent-create').disabled &&
          document
            .getElementById('new-agent-error')
            .textContent.includes('Initial message temporarily unavailable'),
        'Initial message failure did not offer retry',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('new-agent-recent').disabled,
        ),
        true,
      );
      dialogErrors.delete('promptSession');
      await click('new-agent-create');
      await until(
        () => !document.getElementById('new-agent-dialog').open,
        'Retry did not finish conversation',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession'),
        [
          {
            method: 'createSession',
            input: {
              cwd: other,
              name: 'Review the workspace',
              templateId: 'writer',
            },
          },
        ],
      );
      assert.equal(
        calls.some(call => call.method === 'chooseFolder'),
        false,
      );
      assert.deepEqual(
        calls
          .filter(call => call.method === 'prompt')
          .map(call => call.request),
        [{prompt: 'Inspect its files'}, {prompt: 'Inspect its files'}],
      );
      recentProjects = [other];
      await click('open-new-agent');
      await until(
        () => document.getElementById('new-agent-recent').options.length === 2,
        'Reopening did not refresh recent workspace history',
      );
      await click('new-agent-cancel');
    },
  );

  await run(
    'New conversation recent workspace failures allow folder selection and template retry',
    async () => {
      const other = join(directory, 'other-project');
      const click = id =>
        evaluate(id => document.getElementById(id).click(), id);
      recentProjectsError = 'History unavailable';
      await click('open-new-agent');
      await until(
        () =>
          document
            .getElementById('new-agent-recent-error')
            .textContent.includes('History unavailable'),
        'Recent workspace loading error was not shown',
      );
      await until(
        () => !document.getElementById('new-agent-create').disabled,
        'Recent history failure blocked conversation creation',
      );
      dialogErrors.set('chooseFolder', 'Picker unavailable');
      await click('new-agent-choose-folder');
      await until(
        () =>
          document
            .getElementById('new-agent-error')
            .textContent.includes('Picker unavailable'),
        'Folder picker failure was not shown',
      );
      dialogErrors.delete('chooseFolder');
      await click('new-agent-choose-folder');
      await until(
        () => !document.getElementById('new-agent-choose-folder').disabled,
        'Cancelled folder picker stayed busy',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('new-agent-folder').textContent,
        ),
        directory,
      );
      chosenFolder = other;
      workspaceTemplateErrors.set(other, 'Workspace agents unavailable');
      await click('new-agent-choose-folder');
      await until(
        () =>
          document
            .getElementById('new-agent-error')
            .textContent.includes('Workspace agents unavailable'),
        'Workspace template failure was not shown',
      );
      assert.deepEqual(
        await evaluate(() => ({
          count: document.getElementById('new-agent-template').options.length,
          disabled: document.getElementById('new-agent-create').disabled,
        })),
        {count: 0, disabled: true},
      );
      await click('new-agent-cancel');
      recentProjectsError = undefined;
      await click('open-new-agent');
      await until(
        () => !document.getElementById('new-agent-recent').disabled,
        'Recent history did not recover',
      );
      workspaceTemplateErrors.delete(other);
      await evaluate(other => {
        const recent = document.getElementById('new-agent-recent');
        recent.value = other;
        recent.dispatchEvent(new Event('change'));
      }, other);
      await until(
        () => !document.getElementById('new-agent-create').disabled,
        'Workspace retry did not reload templates',
      );
      assert.equal(
        await evaluate(() => document.getElementById('new-agent-error').hidden),
        true,
      );
      await click('new-agent-cancel');
      recentProjects = [];
      await click('open-new-agent');
      await until(
        () =>
          document.getElementById('new-agent-recent-status').textContent ===
          'No recent workspaces yet.',
        'Empty recent history was not shown',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('new-agent-recent').disabled,
        ),
        true,
      );
      await click('new-agent-cancel');
    },
  );

  await run(
    'New conversation ignores stale workspace, history, and folder picker results',
    async () => {
      const other = join(directory, 'other-project');
      const click = id =>
        evaluate(id => document.getElementById(id).click(), id);
      workspaceTemplateDelays.set(directory, 250);
      workspaceTemplateErrors.set(directory, 'Stale template error');
      workspaceTemplateResponses.set(other, {
        templates: [{id: 'other', name: 'Other workspace', scope: 'workspace'}],
        defaultAgentId: 'other',
      });
      await click('open-new-agent');
      await until(
        () => !document.getElementById('new-agent-recent').disabled,
        'Recent choices did not load during template request',
      );
      await evaluate(other => {
        const recent = document.getElementById('new-agent-recent');
        recent.value = other;
        recent.dispatchEvent(new Event('change'));
      }, other);
      await until(
        () => document.getElementById('new-agent-template').value === 'other',
        'Latest workspace did not load',
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(
        await evaluate(() => document.getElementById('new-agent-error').hidden),
        true,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('new-agent-template').value,
        ),
        'other',
      );
      await click('new-agent-cancel');
      workspaceTemplateErrors.clear();
      recentProjectsDelay = 250;
      recentProjects = [directory];
      workspaceTemplateDelays.set(directory, 250);
      await click('open-new-agent');
      await click('new-agent-cancel');
      recentProjectsDelay = 0;
      recentProjects = [other];
      workspaceTemplateDelays.clear();
      workspaceTemplateResponses.set(directory, {
        templates: [{id: 'fresh', scope: 'workspace'}],
        defaultAgentId: 'fresh',
      });
      await click('open-new-agent');
      await until(
        () =>
          document.getElementById('new-agent-template').value === 'fresh' &&
          document.getElementById('new-agent-recent').options.length === 2,
        'Reopened dialog did not load fresh results',
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.deepEqual(
        await evaluate(() => ({
          agent: document.getElementById('new-agent-template').value,
          folders: [...document.getElementById('new-agent-recent').options]
            .slice(1)
            .map(option => option.value),
        })),
        {agent: 'fresh', folders: [other]},
      );
      chosenFolder = other;
      dialogDelays.set('chooseFolder', 250);
      await click('new-agent-choose-folder');
      await click('new-agent-cancel');
      await click('open-new-agent');
      await until(
        () => !document.getElementById('new-agent-create').disabled,
        'Reopened dialog stayed busy',
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.deepEqual(
        await evaluate(() => ({
          folder: document.getElementById('new-agent-folder').textContent,
          agent: document.getElementById('new-agent-template').value,
        })),
        {folder: directory, agent: 'fresh'},
      );
      await click('new-agent-cancel');
    },
  );

  await run(
    'agent template model dropdown loads tool settings and preserves pins',
    async () => {
      const click = id =>
        evaluate(id => document.getElementById(id).click(), id);
      const fill = values =>
        evaluate(values => {
          for (const [id, value] of Object.entries(values)) {
            const element = document.getElementById(id);
            element.value = value;
            element.dispatchEvent(new Event('input', {bubbles: true}));
            if (element.tagName === 'SELECT')
              element.dispatchEvent(new Event('change', {bubbles: true}));
          }
        }, values);
      const modelControls = () =>
        evaluate(() => {
          const select = document.getElementById('agent-template-model');
          return {
            value: select.value,
            disabled: select.disabled,
            options: [...select.options].map(option => ({
              value: option.value,
              text: option.textContent,
              disabled: option.disabled,
            })),
          };
        });
      const availableOptions = inherit => [
        {value: '', text: inherit, disabled: false},
        {
          value: 'fixture-other/large',
          text: 'Fixture large (fixture-other/large)',
          disabled: false,
        },
        {
          value: 'fixture/small',
          text: 'Fixture small (fixture/small)',
          disabled: false,
        },
      ];
      const openTemplates = async () => {
        await click('open-agent-templates');
        await until(
          () => !document.getElementById('agent-template-new').disabled,
          'Agent configurations did not load',
        );
      };
      const selectSaved = async () => {
        await evaluate(() =>
          document
            .querySelector('[data-template-key="workspace:model-agent"]')
            .click(),
        );
      };

      toolSettings = fixtureToolSettings(['fixture/small']);
      await openTemplates();
      assert.deepEqual(
        calls.filter(call => call.method === 'getToolSettings'),
        [{method: 'getToolSettings', sessionId: 'alpha'}],
      );
      await click('agent-template-new');
      assert.deepEqual(await modelControls(), {
        value: '',
        disabled: false,
        options: availableOptions('Use tool model settings'),
      });
      await fill({
        'agent-template-id': 'model-agent',
        'agent-template-name': 'Model agent',
        'agent-template-model': 'fixture-other/large',
        'agent-template-instructions': 'Use the configured model.',
      });
      await click('agent-template-save');
      await until(
        () =>
          document.getElementById('agent-templates-status').textContent ===
          'Saved.',
        'Agent model pin was not saved',
      );
      let saved = calls
        .filter(call => call.method === 'saveAgentTemplate')
        .at(-1).input;
      assert.equal(saved.model, 'fixture-other/large');

      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        const showModelField = async () => {
          const centerModelField = () =>
            evaluate(() => {
              const body = document.querySelector(
                '.agent-template-editor-body',
              );
              const field = document.getElementById('agent-template-model');
              if (document.activeElement !== field) {
                document.activeElement?.blur();
                field.focus({preventScroll: true});
              }
              const viewport = body.getBoundingClientRect();
              const bounds = field.getBoundingClientRect();
              body.scrollTop +=
                bounds.top -
                viewport.top -
                (body.clientHeight - bounds.height) / 2;
              const positioned = field.getBoundingClientRect();
              return {
                visible:
                  field.checkVisibility() &&
                  positioned.top >= viewport.top &&
                  positioned.bottom <= viewport.bottom,
                scrollTop: body.scrollTop,
                field: {
                  top: positioned.top,
                  bottom: positioned.bottom,
                },
                viewport: {top: viewport.top, bottom: viewport.bottom},
              };
            });
          await centerModelField();
          await settle();
          const geometry = await centerModelField();
          assert.equal(
            geometry.visible,
            true,
            `Model dropdown must be visible in its editor before capture: ${JSON.stringify(geometry)}`,
          );
        };
        await showModelField();
        await screenshot('agent-template-model-normal');
        window.setContentSize(900, 760);
        window.webContents.setZoomFactor(1.5);
        await settle();
        await showModelField();
        await screenshot('agent-template-model-compact-zoom');
        window.setContentSize(1600, 1000);
        window.webContents.setZoomFactor(1);
        await settle();
      }
      await click('agent-templates-close');

      toolSettings = fixtureToolSettings(['fixture/small']);
      await openTemplates();
      await selectSaved();
      let controls = await modelControls();
      assert.equal(controls.value, 'fixture-other/large');
      assert.deepEqual(
        controls.options.find(option => option.value === 'fixture-other/large'),
        {
          value: 'fixture-other/large',
          text: 'Fixture large (fixture-other/large)',
          disabled: false,
        },
        'A saved available pin remains enabled outside the allowlist',
      );
      assert.equal(
        controls.options.find(option => option.value === '').text,
        'Use tool model settings',
      );
      await fill({'agent-template-description': 'Keep this unrelated edit.'});
      await click('agent-template-save');
      await until(
        () =>
          document.getElementById('agent-templates-status').textContent ===
          'Saved.',
        'Saved model pin was not preserved',
      );
      saved = calls
        .filter(call => call.method === 'saveAgentTemplate')
        .at(-1).input;
      assert.equal(saved.model, 'fixture-other/large');

      toolSettings = fixtureToolSettings([]);
      chosenFolder = join(directory, 'empty-model-list');
      await click('agent-templates-choose-folder');
      await until(
        () => !document.getElementById('agent-template-new').disabled,
        'Folder change did not reload empty model settings',
      );
      assert.equal(
        calls.filter(call => call.method === 'getToolSettings').length,
        3,
        'Folder change must reload model settings',
      );
      await click('agent-template-new');
      assert.deepEqual(await modelControls(), {
        value: '',
        disabled: false,
        options: availableOptions('Inherit'),
      });
      await click('agent-templates-close');

      toolSettings = fixtureToolSettings(null);
      await openTemplates();
      await click('agent-template-new');
      assert.deepEqual(await modelControls(), {
        value: '',
        disabled: false,
        options: availableOptions('Inherit'),
      });
      await click('agent-templates-close');

      toolSettings = fixtureToolSettings(['fixture/small']);
      toolSettings.models = toolSettings.models.filter(
        model => model.id !== 'large',
      );
      await openTemplates();
      await selectSaved();
      controls = await modelControls();
      assert.equal(controls.value, 'fixture-other/large');
      assert.deepEqual(
        controls.options.find(option => option.value === 'fixture-other/large'),
        {
          value: 'fixture-other/large',
          text: 'fixture-other/large (unavailable)',
          disabled: true,
        },
        'An unavailable saved pin remains visible',
      );
      await click('agent-templates-close');

      toolSettingsError = 'Model settings failed';
      await openTemplates();
      await until(
        () =>
          document
            .getElementById('agent-templates-error')
            .textContent.includes('Model settings failed'),
        'Model settings failure was not shown',
      );
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('.agent-template-list-item').length,
        ),
        6,
        'Agent configurations must still load when models fail',
      );
      await selectSaved();
      controls = await modelControls();
      assert.equal(controls.disabled, true);
      assert.equal(controls.value, 'fixture-other/large');
      assert.ok(
        controls.options.some(
          option => option.value === 'fixture-other/large' && option.disabled,
        ),
        'The saved model remains selected while model settings are unavailable',
      );
      assert.deepEqual(
        calls
          .filter(call => call.method === 'getToolSettings')
          .map(call => call.sessionId),
        ['alpha', 'alpha', 'alpha', 'alpha', 'alpha', 'alpha'],
        'Opening and changing folders reloads settings for the selected session',
      );
      await click('agent-templates-close');
    },
  );

  await run(
    'scoped default configurations remain selected below workspace overrides',
    async () => {
      const global = agentDefinition('global', 'reviewer', {
        name: 'Shared reviewer',
        mode: 'all',
        instructions: 'Use the shared review instructions.',
      });
      agentTemplates.push(
        global,
        agentDefinition('workspace', 'reviewer', {
          name: 'Personal reviewer',
          mode: 'all',
          instructions: 'Use the personal review instructions.',
        }),
      );
      defaultAgentId = 'global:reviewer';
      defaultAgent = mergeAgentDefinitions('reviewer', [global]);
      creationIds = ['scoped-review-session'];
      await evaluate(() => document.getElementById('open-new-agent').click());
      await until(
        () => !document.getElementById('new-agent-template').disabled,
        'Scoped default configuration did not load',
      );
      assert.deepEqual(
        await evaluate(() => {
          const select = document.getElementById('new-agent-template');
          return {
            selected: select.value,
            label: select.selectedOptions[0].textContent,
            personalAvailable: [...select.options].some(
              option =>
                option.value === 'reviewer' &&
                option.textContent.includes('Personal reviewer'),
            ),
          };
        }),
        {
          selected: 'global:reviewer',
          label: 'Shared reviewer · Global',
          personalAvailable: true,
        },
      );
      for (const [width, height, zoom] of [
        [1600, 1000, 1],
        [1100, 760, 1.5],
      ]) {
        window.setContentSize(width, height);
        window.webContents.setZoomFactor(zoom);
        await settle();
        assert.equal(
          await evaluate(() => {
            const select = document
              .getElementById('new-agent-template')
              .getBoundingClientRect();
            const create = document
              .getElementById('new-agent-create')
              .getBoundingClientRect();
            return (
              select.width > 0 &&
              select.top >= 0 &&
              select.right <= innerWidth &&
              create.bottom <= innerHeight &&
              document.documentElement.scrollHeight <= innerHeight
            );
          }),
          true,
          'Scoped configuration and create control must remain accessible',
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`scoped-default-${width}-${zoom}`);
      }
      await evaluate(() => document.getElementById('new-agent-create').click());
      await until(
        () => !document.getElementById('new-agent-dialog').open,
        'Scoped default conversation did not open',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession').at(-1),
        {
          method: 'createSession',
          input: {cwd: directory, templateId: 'global:reviewer'},
        },
      );
      assert.equal(
        resources.get('scoped-review-session').agentProfile.name,
        'Shared reviewer',
      );
    },
  );

  await run(
    'agent templates support global, repository, and personal workspace scopes and create conversations',
    async () => {
      const fill = async values =>
        evaluate(values => {
          for (const [id, value] of Object.entries(values)) {
            const element = document.getElementById(id);
            element.value = value;
            element.dispatchEvent(new Event('input', {bubbles: true}));
            if (element.tagName === 'SELECT')
              element.dispatchEvent(new Event('change', {bubbles: true}));
          }
        }, values);
      const click = id =>
        evaluate(id => document.getElementById(id).click(), id);
      await until(
        () =>
          document.getElementById('agent-profile-label').textContent ===
          'Default',
        'Legacy feature responses did not fall back to Default',
      );
      creationIds = ['plain-agent-session'];
      const plainPromptCount = calls.filter(
        call => call.method === 'prompt',
      ).length;
      await click('open-new-agent');
      await until(
        () => !document.getElementById('new-agent-template').disabled,
        'Plain conversation choices did not load',
      );
      assert.deepEqual(
        await evaluate(() => ({
          values: [
            ...document.getElementById('new-agent-template').options,
          ].map(option => option.value),
          selected: document.getElementById('new-agent-template').value,
          name: document.getElementById('new-agent-name').value,
          namePlaceholder:
            document.getElementById('new-agent-name').placeholder,
          startDisabled: document.getElementById('new-agent-create').disabled,
        })),
        {
          values: ['build', 'default', 'plan'],
          selected: 'default',
          name: '',
          namePlaceholder: basename(directory),
          startDisabled: false,
        },
        'A workspace without custom profiles selects the Default agent',
      );
      await click('new-agent-create');
      await until(
        () => !document.getElementById('new-agent-dialog').open,
        'Plain conversation did not open',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession').at(-1),
        {
          method: 'createSession',
          input: {cwd: directory, templateId: 'default'},
        },
      );
      assert.equal(
        calls.filter(call => call.method === 'prompt').length,
        plainPromptCount,
      );
      await until(
        () =>
          document.getElementById('agent-profile-label').textContent ===
          'Default',
        'Selected Default agent was not shown in conversation controls',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('default-agent-conversation');
      await click('open-commands');
      await until(
        () => document.getElementById('commands-dialog').open,
        'Session settings did not open',
      );
      assert.equal(
        await evaluate(
          () =>
            document.getElementById('session-maintenance-agent').textContent,
        ),
        'Default',
      );
      await click('close-commands');
      agentTemplates.push(...authoredAgentTemplates());
      defaultAgentId = 'writer';
      await click('open-workspace-config');
      assert.deepEqual(calls.at(-1), {
        method: 'openWorkspaceConfiguration',
        cwd: directory,
      });
      await click('open-agent-templates');
      await until(
        () =>
          document.querySelectorAll('.agent-template-list-item').length === 14,
        'Raw agent definitions did not load',
      );
      const rawAgentText = await evaluate(
        () => document.getElementById('agent-template-list').textContent,
      );
      for (const label of [
        'Default',
        'Build',
        'Plan',
        'General',
        'Explore',
        'Writer',
        'Researcher',
        'Flexible agent',
        'Hidden helper',
        'Disabled helper',
        'team/reviewer',
      ])
        assert.match(rawAgentText, new RegExp(label));
      assert.deepEqual(
        (() => {
          const effective = listFixtureAgentTemplates(directory).templates.find(
            item => item.id === 'team/reviewer',
          );
          return {
            name: effective.name,
            instructions: effective.instructions,
            mode: effective.mode,
            context: effective.context,
            steps: effective.steps,
            permissions: effective.permissions,
            scope: effective.scope,
          };
        })(),
        {
          name: 'Team reviewer',
          instructions: 'Review changes and report concrete findings.',
          mode: 'all',
          context: 'task',
          steps: 6,
          permissions: [
            {action: 'edit', resource: '*', effect: 'deny'},
            {action: 'read', resource: 'src/**', effect: 'allow'},
            {action: 'read', resource: 'packages/app/**', effect: 'allow'},
          ],
          scope: 'workspace',
        },
      );
      await evaluate(() =>
        document
          .querySelector('[data-template-key="repository:team/reviewer"]')
          .click(),
      );
      assert.deepEqual(
        await evaluate(() => ({
          name: document.getElementById('agent-template-name').value,
          instructions: document.getElementById('agent-template-instructions')
            .value,
          mode: document.getElementById('agent-template-mode').value,
          context: document.getElementById('agent-template-context').value,
          permissions: JSON.parse(
            document.getElementById('agent-template-permissions').value,
          ),
          contextNote: document
            .getElementById('agent-template-context-note')
            .checkVisibility(),
        })),
        {
          name: '',
          instructions: '',
          mode: '',
          context: 'task',
          permissions: [{action: 'read', resource: 'src/**', effect: 'allow'}],
          contextNote: true,
        },
      );
      const nestedReviewerPath = join(
        directory,
        'packages',
        'app',
        '.varisdev',
        'agents',
        'team',
        'reviewer.md',
      );
      await evaluate(() =>
        [
          ...document.querySelectorAll(
            '[data-template-key="repository:team/reviewer"]',
          ),
        ]
          .find(button =>
            button.dataset.templateIdentity
              .replaceAll('\\', '/')
              .includes('/packages/app/'),
          )
          .click(),
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('agent-template-description').value,
        ),
        'Applies package review rules.',
      );
      await fill({
        'agent-template-description': 'Updated package review rules.',
      });
      await click('agent-template-save');
      await until(
        () =>
          document.getElementById('agent-templates-status').textContent ===
          'Saved.',
        'Nested repository definition was not saved',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'saveAgentTemplate').at(-1).input,
        {
          scope: 'repository',
          id: 'team/reviewer',
          sourcePath: nestedReviewerPath,
          description: 'Updated package review rules.',
          permissions: [
            {action: 'read', resource: 'packages/app/**', effect: 'allow'},
          ],
        },
      );
      await click('agent-template-new');
      await fill({
        'agent-template-scope': 'global',
        'agent-template-id': 'reviewer',
        'agent-template-name': 'Global reviewer',
        'agent-template-description': 'Review changes and tests',
        'agent-template-mode': 'all',
        'agent-template-context': 'task',
        'agent-template-model': 'fixture/small',
        'agent-template-thinking': 'high',
        'agent-template-color': '#ff6b6b',
        'agent-template-steps': '8',
        'agent-template-permissions': '{"action":"read"}',
        'agent-template-instructions':
          'Review changes and report concrete findings.',
      });
      const saveCalls = calls.filter(
        call => call.method === 'saveAgentTemplate',
      ).length;
      await click('agent-template-save');
      await until(
        () =>
          document
            .getElementById('agent-templates-error')
            .textContent.includes('Permissions must be a JSON list'),
        'Invalid permissions were accepted',
      );
      assert.equal(
        calls.filter(call => call.method === 'saveAgentTemplate').length,
        saveCalls,
        'Invalid permissions must not reach the backend',
      );
      await fill({
        'agent-template-permissions': JSON.stringify([
          {action: 'edit', resource: '*', effect: 'deny'},
          {action: 'read', resource: 'src/**', effect: 'allow'},
        ]),
      });
      templateError = 'Template write failed';
      await click('agent-template-save');
      await until(
        () =>
          document
            .getElementById('agent-templates-error')
            .textContent.includes('Template write failed'),
        'Save failure was hidden',
      );
      assert.deepEqual(
        await evaluate(() => ({
          instructions: document.getElementById('agent-template-instructions')
            .value,
          mode: document.getElementById('agent-template-mode').value,
          context: document.getElementById('agent-template-context').value,
          color: document.getElementById('agent-template-color').value,
          steps: document.getElementById('agent-template-steps').value,
          permissions: JSON.parse(
            document.getElementById('agent-template-permissions').value,
          ),
        })),
        {
          instructions: 'Review changes and report concrete findings.',
          mode: 'all',
          context: 'task',
          color: '#ff6b6b',
          steps: '8',
          permissions: [
            {action: 'edit', resource: '*', effect: 'deny'},
            {action: 'read', resource: 'src/**', effect: 'allow'},
          ],
        },
      );
      templateError = undefined;
      await click('agent-template-save');
      await until(
        () =>
          document.getElementById('agent-templates-status').textContent ===
          'Saved.',
        'Global template was not saved',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'saveAgentTemplate').at(-1).input,
        {
          scope: 'global',
          id: 'reviewer',
          name: 'Global reviewer',
          description: 'Review changes and tests',
          mode: 'all',
          context: 'task',
          model: 'fixture/small',
          thinkingLevel: 'high',
          color: '#ff6b6b',
          steps: 8,
          instructions: 'Review changes and report concrete findings.',
          permissions: [
            {action: 'edit', resource: '*', effect: 'deny'},
            {action: 'read', resource: 'src/**', effect: 'allow'},
          ],
        },
      );
      assert.equal(
        agentTemplates.find(item => item.key === 'global:reviewer').scope,
        'global',
      );
      await click('agent-template-new');
      await fill({
        'agent-template-id': 'reviewer',
        'agent-template-scope': 'repository',
        'agent-template-name': 'Repository reviewer',
        'agent-template-instructions':
          'Use the repository conventions for review.',
      });
      await click('agent-template-save');
      await until(
        () =>
          document
            .getElementById('agent-template-list')
            .textContent.includes('Customized in repository'),
        'Repository customization is missing',
      );
      assert.equal(agentTemplates.length, 16);
      assert.match(
        await evaluate(
          () => document.getElementById('agent-template-source').textContent,
        ),
        /\.varisdev[/\\]agents[/\\]reviewer\.md$/,
      );
      await click('agent-template-new');
      await fill({
        'agent-template-scope': 'workspace',
        'agent-template-id': 'reviewer',
        'agent-template-name': 'Personal reviewer',
        'agent-template-instructions':
          'Use my personal workspace review preferences.',
      });
      await click('agent-template-save');
      await until(
        () =>
          document.getElementById('agent-templates-status').textContent ===
          'Saved.',
        'Workspace configuration was not saved',
      );
      assert.equal(agentTemplates.length, 17);
      assert.match(
        await evaluate(
          () => document.getElementById('agent-template-source').textContent,
        ),
        /settings\/workspaces\/project\/agents\/reviewer\.md$/,
      );
      assert.match(
        await evaluate(
          () => document.getElementById('agent-template-list').textContent,
        ),
        /Customized in workspace/,
      );
      await evaluate(() =>
        document.querySelector('[data-template-key="global:reviewer"]').click(),
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await screenshot('agent-templates-v2-normal');
        await evaluate(() => {
          const body = document.querySelector('.agent-template-editor-body');
          body.scrollTop = body.scrollHeight;
        });
        await settle();
        await screenshot('agent-templates-v2-permissions');
        await evaluate(() => {
          document.querySelector('.agent-template-editor-body').scrollTop = 0;
        });
        await settle();
        const themes = await evaluate(() =>
          [...document.getElementById('factory-theme').options].map(
            option => option.value,
          ),
        );
        for (const theme of themes) {
          await evaluate(theme => {
            const select = document.getElementById('factory-theme');
            select.value = theme;
            select.dispatchEvent(new Event('change'));
          }, theme);
          await screenshot(`agent-templates-${theme}`);
        }
        await evaluate(() => {
          const select = document.getElementById('factory-theme');
          select.value = window.fixtureTheme || 'factory';
          select.dispatchEvent(new Event('change'));
        });
      }
      for (const [width, height, zoom] of [
        [900, 760, 1.5],
        [900, 760, 2],
        [1600, 1000, 2],
      ]) {
        window.setContentSize(width, height);
        window.webContents.setZoomFactor(zoom);
        await settle();
        assert.equal(
          await evaluate(() => {
            const dialog = document
              .getElementById('agent-templates-dialog')
              .getBoundingClientRect();
            return (
              dialog.left >= 0 &&
              dialog.top >= 0 &&
              dialog.right <= innerWidth &&
              dialog.bottom <= innerHeight &&
              [
                'agent-template-save',
                'agent-template-delete',
                'agent-templates-close',
              ].every(id => {
                const button = document.getElementById(id);
                const r = button.getBoundingClientRect();
                return (
                  button.checkVisibility() &&
                  r.top >= dialog.top &&
                  r.bottom <= dialog.bottom &&
                  r.right <= dialog.right &&
                  button.contains(
                    document.elementFromPoint(
                      r.left + r.width / 2,
                      r.top + r.height / 2,
                    ),
                  )
                );
              })
            );
          }),
          true,
          'Template actions must remain visible at compact sizes',
        );
        if (
          await evaluate(() =>
            document.getElementById('agent-template-picker').checkVisibility(),
          )
        ) {
          await fill({
            'agent-template-picker':
              'global:/fixture/settings/agents/reviewer.md',
          });
          assert.equal(
            await evaluate(
              () => document.getElementById('agent-template-scope').value,
            ),
            'global',
          );
          assert.equal(
            await evaluate(
              () =>
                document.getElementById('agent-template-instructions').value,
            ),
            'Review changes and report concrete findings.',
          );
          await fill({
            'agent-template-picker':
              'workspace:/fixture/settings/workspaces/project/agents/reviewer.md',
          });
          assert.equal(
            await evaluate(
              () => document.getElementById('agent-template-scope').value,
            ),
            'workspace',
          );
          assert.ok(
            await evaluate(
              () =>
                document
                  .querySelector('.agent-template-editor-body')
                  .getBoundingClientRect().height >= 40,
            ),
            'Compact editor must retain space for its fields',
          );
        }
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
          await screenshot(`agent-templates-${width}-${zoom}`);
      }
      await click('agent-templates-close');
      window.setContentSize(1600, 1000);
      window.webContents.setZoomFactor(1);
      await settle();
      await click('open-new-agent');
      await until(
        () =>
          document.querySelectorAll('#new-agent-template option').length === 7,
        'Effective primary agent choices did not load',
      );
      assert.deepEqual(
        await evaluate(() => ({
          values: [
            ...document.getElementById('new-agent-template').options,
          ].map(option => option.value),
          selected: document.getElementById('new-agent-template').value,
          name: document.getElementById('new-agent-name').value,
        })),
        {
          values: [
            'build',
            'default',
            'flex',
            'plan',
            'reviewer',
            'team/reviewer',
            'writer',
          ],
          selected: 'writer',
          name: '',
        },
        'Only visible enabled primary-capable agents are offered and the configured writer is selected',
      );
      await fill({
        'new-agent-template': 'reviewer',
        'new-agent-task': 'Review the current change.',
      });
      assert.deepEqual(
        await evaluate(() => ({
          name: document.getElementById('new-agent-name').value,
          placeholder: document.getElementById('new-agent-name').placeholder,
        })),
        {name: '', placeholder: basename(directory)},
        'Selecting an agent keeps the optional name blank',
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('agent-create-template');
      creationIds = ['review-session'];
      creationError = 'Agent creation failed';
      await click('new-agent-create');
      await until(
        () =>
          document
            .getElementById('new-agent-error')
            .textContent.includes('Agent creation failed'),
        'Creation failure was hidden',
      );
      creationError = undefined;
      await fill({'new-agent-name': 'Interactive reviewer'});
      await click('new-agent-create');
      await until(
        () => !document.getElementById('new-agent-dialog').open,
        'New agent did not open',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession').at(-1),
        {
          method: 'createSession',
          input: {
            cwd: directory,
            name: 'Interactive reviewer',
            templateId: 'reviewer',
          },
        },
      );
      assert.deepEqual(
        hub.sessions.map(item => item.session.id),
        ['alpha', 'beta', 'plain-agent-session', 'review-session'],
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('inspector-title').textContent,
        ),
        'Interactive reviewer',
      );
      await until(
        () =>
          document.getElementById('agent-profile-label').textContent ===
          'Personal reviewer',
        'Selected reviewer profile was not shown',
      );
      assert.deepEqual(calls.filter(call => call.method === 'prompt').at(-1), {
        method: 'prompt',
        sessionId: 'review-session',
        request: {prompt: 'Review the current change.'},
      });
      assert.equal(
        calls.some(call => call.method === 'closeSession'),
        false,
      );
      await click('open-agent-templates');
      await until(
        () =>
          document.querySelectorAll('.agent-template-list-item').length === 17,
        'Saved agent definitions did not return',
      );
      await evaluate(() =>
        [...document.querySelectorAll('.agent-template-list-item')]
          .find(item => item.textContent.includes('Personal reviewer'))
          .click(),
      );
      await click('agent-template-delete');
      await click('agent-template-delete-confirm');
      await until(
        () =>
          document.querySelectorAll('.agent-template-list-item').length === 16,
        'Personal workspace configuration did not delete',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'deleteAgentTemplate').at(-1)
          .input,
        {
          scope: 'workspace',
          id: 'reviewer',
          sourcePath: '/fixture/settings/workspaces/project/agents/reviewer.md',
        },
      );
      await evaluate(() =>
        [...document.querySelectorAll('.agent-template-list-item')]
          .find(item => item.textContent.includes('Repository reviewer'))
          .click(),
      );
      await click('agent-template-delete');
      await click('agent-template-delete-confirm');
      await until(
        () =>
          document.querySelectorAll('.agent-template-list-item').length === 15,
        'Repository template did not delete',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'deleteAgentTemplate').at(-1)
          .input,
        {
          scope: 'repository',
          id: 'reviewer',
          sourcePath: join(directory, '.varisdev', 'agents', 'reviewer.md'),
        },
      );
      assert.equal(
        agentTemplates.find(item => item.key === 'global:reviewer').scope,
        'global',
      );
      await click('agent-templates-close');
      const promptCount = calls.filter(call => call.method === 'prompt').length;
      creationIds = ['empty-review'];
      await click('open-new-agent');
      await until(
        () => !document.getElementById('new-agent-template').disabled,
        'Agent choices did not load',
      );
      await fill({'new-agent-template': 'reviewer', 'new-agent-name': ''});
      await click('new-agent-create');
      await until(
        () => !document.getElementById('new-agent-dialog').open,
        'Conversation without an initial message did not open',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'createSession').at(-1),
        {
          method: 'createSession',
          input: {cwd: directory, templateId: 'reviewer'},
        },
      );
      assert.equal(
        calls.filter(call => call.method === 'prompt').length,
        promptCount,
        'Opening a conversation does not require sending a task',
      );
      const only = hub.sessions.find(
        item => item.session.id === 'empty-review',
      );
      only.session.name = 'Reviewer';
      hub.sessions = [only];
      hub.selectedSessionId = only.session.id;
      await publish();
      assert.equal(
        await evaluate(
          () => document.querySelectorAll('#scene-labels button').length,
        ),
        1,
        'One agent has one robot target in the scene',
      );
      assert.equal(
        await evaluate(() => document.getElementById('parent-controls').hidden),
        false,
      );
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR)
        await screenshot('single-agent-workspace');
      await click('open-agent-templates');
      await until(
        () =>
          document.querySelectorAll('.agent-template-list-item').length === 15,
        'Built-in agents were not listed',
      );
      await evaluate(() =>
        document.querySelector('[data-template-key="builtin:general"]').click(),
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('agent-template-scope').value,
        ),
        'workspace',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('agent-template-delete').hidden,
        ),
        true,
      );
      await fill({
        'agent-template-name': '',
        'agent-template-description': '',
        'agent-template-mode': '',
        'agent-template-context': '',
        'agent-template-hidden': '',
        'agent-template-disabled': '',
        'agent-template-color': '',
        'agent-template-steps': '',
        'agent-template-permissions': '',
        'agent-template-instructions': 'Use my review conventions.',
      });
      await click('agent-template-save');
      await until(
        () =>
          document.querySelectorAll('.agent-template-list-item').length === 16,
        'Built-in customization was not saved',
      );
      assert.deepEqual(
        calls.filter(call => call.method === 'saveAgentTemplate').at(-1).input,
        {
          scope: 'workspace',
          id: 'general',
          instructions: 'Use my review conventions.',
        },
        'Empty customization fields inherit the built-in definition',
      );
      assert.equal(
        agentTemplates.find(item => item.key === 'builtin:general')
          .instructions,
        '',
      );
      assert.equal(
        agentTemplates.find(item => item.key === 'workspace:general')
          .instructions,
        'Use my review conventions.',
      );
      const filenameIds = [
        'sf-agent.test',
        'My Agent (Ä).test',
        ' leading and trailing ',
        'global:Colon (Ä)',
      ];
      for (const id of filenameIds) {
        await click('agent-template-new');
        await fill({
          'agent-template-id': id,
          'agent-template-mode': 'all',
          'agent-template-instructions': 'Use the exact filename.',
        });
        await click('agent-template-save');
        await until(
          () =>
            document.getElementById('agent-templates-status').textContent ===
              'Saved.' && document.getElementById('agent-template-id').disabled,
          'Ordinary filename configuration did not save',
        );
        assert.equal(
          calls.filter(call => call.method === 'saveAgentTemplate').at(-1).input
            .id,
          id,
        );
        assert.equal(
          await evaluate(
            () => document.getElementById('agent-template-id').value,
          ),
          id,
        );
        assert.ok(
          agentTemplates.some(
            template => template.id === id && template.scope === 'workspace',
          ),
        );
        assert.ok(
          (
            await evaluate(
              () =>
                document.getElementById('agent-template-source').textContent,
            )
          ).endsWith(`${id}.md`),
        );
      }
      if (process.env.DESKTOP_UI_SCREENSHOT_DIR) {
        await evaluate(() =>
          document
            .getElementById('agent-template-id')
            .scrollIntoView({block: 'center'}),
        );
        await screenshot('ordinary-filename-editor');
      }
      await click('agent-templates-close');
      for (const [index, id] of filenameIds.entries()) {
        await click('open-new-agent');
        await until(
          () => !document.getElementById('new-agent-template').disabled,
          'Ordinary filename options did not load',
        );
        const selector = id.includes(':') ? `workspace:${id}` : id;
        await evaluate(selector => {
          const select = document.getElementById('new-agent-template');
          select.value = selector;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }, selector);
        assert.equal(
          await evaluate(
            () => document.getElementById('new-agent-template').value,
          ),
          selector,
        );
        if (process.env.DESKTOP_UI_SCREENSHOT_DIR && index === 1)
          await screenshot('ordinary-filename-selection');
        creationIds = [`ordinary-filename-${index}`];
        await click('new-agent-create');
        await until(
          () => !document.getElementById('new-agent-dialog').open,
          'Ordinary filename selection did not create a conversation',
        );
        assert.equal(
          calls.filter(call => call.method === 'createSession').at(-1).input
            .templateId,
          selector,
        );
        assert.equal(
          resources.get(`ordinary-filename-${index}`).agentProfile.id,
          id,
        );
      }
    },
  );
}

function finishRun() {
  let code = report.fatal || report.cases.some(result => result.error) ? 1 : 0;
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch (error) {
    code = 1;
    console.error('Could not write UI report:', error);
  }
  try {
    if (window && !window.isDestroyed()) window.destroy();
  } catch (error) {
    code = 1;
    console.error('Could not destroy UI fixture:', error);
  } finally {
    app.exit(code);
  }
}

main()
  .catch(error => {
    report.fatal = error.stack || String(error);
  })
  .finally(finishRun);
