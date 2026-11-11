#!/usr/bin/env node
// Offline diagnostics only. Do not initialize the app, resolve credentials, or load extensions.
import {Buffer} from 'node:buffer';
import console from 'node:console';
import {constants} from 'node:fs';
import {access, open, realpath, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {fileURLToPath, pathToFileURL, URL} from 'node:url';
import process from 'node:process';
import {setTimeout, clearTimeout} from 'node:timers';

const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() =>
  fileURLToPath(import.meta.url),
);
export const applicationRoot = fileURLToPath(
  new URL('../../../../', pathToFileURL(modulePath)),
);
const record = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value =>
  record(value) && Object.values(value).every(item => typeof item === 'string');
const version = value =>
  typeof value === 'string' &&
  /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
    ? value
    : undefined;
const expand = (path, home, base) =>
  resolve(
    base,
    path === '~'
      ? home
      : /^~[/\\]/.test(path)
        ? join(home, path.slice(2))
        : path,
  );
const keyName = name => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
const hidden = new Set([
  '_',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'ZDOTDIR',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'TERM',
  'TERMCAP',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'TTY',
  'TMPDIR',
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
]);
const publicFields = new Set([
  'VARISDEV_DATA_DIR',
  'VARISDEV_SETTINGS_DIR',
  'PIDEV_DESKTOP_DATA_DIR',
  'PI_OFFLINE',
]);
const environmentField = name =>
  keyName(name) &&
  !hidden.has(name) &&
  !name.startsWith('__') &&
  (publicFields.has(name) ||
    !/^(?:VARISDEV_|PIDEV_|PI_|ELECTRON_|XPC_|VSCODE_)/.test(name));
const suggestedKeys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
];

function locations(env, platform, project) {
  const home =
    (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) ||
    homedir();
  const root = resolve(home, '.varisdev');
  let agent = env.VARISDEV_SETTINGS_DIR
    ? expand(env.VARISDEV_SETTINGS_DIR, home, project)
    : join(root, 'agent');
  if (relative(root, agent) === '') agent = join(root, 'agent');
  const data = env.VARISDEV_DATA_DIR
    ? resolve(project, env.VARISDEV_DATA_DIR)
    : platform === 'darwin'
      ? join(env.HOME || home, 'Library/Application Support/VarisDev')
      : platform === 'win32'
        ? join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'VarisDev')
        : join(env.XDG_DATA_HOME || join(home, '.local/share'), 'varisdev');
  // environment.json is deliberately independent of the configurable data directory.
  const environment =
    platform === 'darwin'
      ? join(
          env.HOME || env.USERPROFILE || home,
          'Library/Application Support/VarisDev/environment.json',
        )
      : platform === 'win32'
        ? join(
            env.LOCALAPPDATA || join(home, 'AppData/Local'),
            'VarisDev/environment.json',
          )
        : join(
            env.XDG_CONFIG_HOME || join(home, '.config'),
            'varisdev/environment.json',
          );
  return {
    home,
    agent,
    data,
    environment,
    desktop: env.PIDEV_DESKTOP_DATA_DIR
      ? resolve(project, env.PIDEV_DESKTOP_DATA_DIR)
      : join(data, 'desktop'),
  };
}

/** Only fixed application modules are imported; no project module resolution is used. */
async function validators(root) {
  for (const prefix of ['desktop', '']) {
    const sdk = join(
      root,
      prefix,
      'node_modules/@earendil-works/pi-coding-agent',
    );
    try {
      await stat(join(sdk, 'package.json'));
      const require = createRequire(join(sdk, 'package.json'));
      const [settings, models, mcp, value, json, references, paths] =
        await Promise.all([
          import(pathToFileURL(join(sdk, 'dist/core/settings-schema.js')).href),
          import(pathToFileURL(join(sdk, 'dist/core/model-config.js')).href),
          import(pathToFileURL(join(sdk, 'dist/core/mcp-servers.js')).href),
          import(pathToFileURL(require.resolve('typebox/value')).href),
          import(pathToFileURL(join(sdk, 'dist/utils/json.js')).href),
          import(
            pathToFileURL(join(sdk, 'dist/core/resolve-config-value.js')).href
          ),
          import(pathToFileURL(join(sdk, 'dist/utils/paths.js')).href),
        ]);
      return {
        settings: input => value.Check(settings.SettingsSchema, input),
        models: input => value.Check(models.ModelsConfigSchema, input),
        mcp: mcp.validateMcpServerConfig,
        stripJsonComments: json.stripJsonComments,
        referenceNames: references.getConfigValueEnvVarNames,
        resolvePath: paths.resolvePath,
      };
    } catch {
      // A broken/missing bundled SDK is reported as limited validation below.
    }
  }
  return {};
}

/** Read a bounded set of regular files. Opening a FIFO/device is never necessary. */
function reader() {
  const cache = new Map();
  let bytes = 0;
  return async (path, comments = false, stripComments) => {
    if (cache.has(path)) return cache.get(path);
    let handle;
    let result;
    try {
      const info = await stat(path);
      if (!info.isFile()) result = {state: 'unreadable'};
      else if (
        info.size > 512 * 1024 ||
        bytes + info.size > 8 * 1024 * 1024 ||
        cache.size >= 160
      )
        result = {state: 'limited'};
      else {
        handle = await open(
          path,
          constants.O_RDONLY | (constants.O_NONBLOCK || 0),
        );
        const opened = await handle.stat();
        if (!opened.isFile()) result = {state: 'unreadable'};
        else {
          const buffer = Buffer.alloc(512 * 1024 + 1);
          const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
          bytes += bytesRead;
          if (bytesRead > 512 * 1024) result = {state: 'limited'};
          else {
            const text = buffer
              .subarray(0, bytesRead)
              .toString('utf8')
              .replace(/^\uFEFF/, '');
            if (comments && !stripComments)
              result = {state: 'schema-unavailable'};
            else {
              try {
                const value = JSON.parse(comments ? stripComments(text) : text);
                result = record(value)
                  ? {state: 'valid', value}
                  : {state: 'invalid-object'};
              } catch {
                // JSON parser errors can quote credentials from the input.
                result = {state: 'invalid-json'};
              }
            }
          }
        }
      }
    } catch (error) {
      result = {state: error.code === 'ENOENT' ? 'missing' : 'unreadable'};
    } finally {
      await handle?.close();
    }
    cache.set(path, result);
    return result;
  };
}

async function canonical(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function workspacePaths(project, agent, home) {
  const globalMarkers = new Set(
    await Promise.all(
      [join(home, '.varisdev'), agent, dirname(agent)].map(canonical),
    ),
  );
  let configRoot;
  let root = project;
  for (
    let current = project, depth = 0;
    depth < 64;
    current = dirname(current), depth++
  ) {
    if (await exists(join(current, '.git'))) {
      root = current;
      break;
    }
    const marker = join(current, '.varisdev');
    if (
      !configRoot &&
      (await exists(marker)) &&
      !globalMarkers.has(await canonical(marker))
    )
      configRoot = current;
    if (dirname(current) === current) {
      root = configRoot || project;
      break;
    }
  }
  return {
    repository: root,
    workspace: join(
      agent,
      'workspaces',
      createHash('sha256').update(root).digest('hex'),
    ),
  };
}

async function executables(name, env, platform, project) {
  const paths = (env.PATH || '').split(delimiter).slice(0, 128);
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const found = [];
  const seen = new Set();
  for (let directory of paths) {
    directory = directory.replace(/^"(.*)"$/, '$1');
    for (const suffix of suffixes) {
      const path = resolve(project, directory, name + suffix);
      try {
        if (!(await stat(path)).isFile()) continue;
        await access(
          path,
          platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        const target = await canonical(path);
        // npm's Windows shell/cmd shims in one directory are one installation.
        const identity =
          platform === 'win32'
            ? join(dirname(target), name).toLowerCase()
            : target;
        if (!seen.has(identity)) {
          found.push({path, target});
          seen.add(identity);
        }
      } catch {
        /* No execution or shell startup during PATH inspection. */
      }
      if (found.length === 8) return found;
    }
  }
  return found;
}

async function writableAncestor(path) {
  for (let current = path; ; current = dirname(current)) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) return false;
      await access(current, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) return false;
    }
  }
}

function validPermissions(value) {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.every(
        rule =>
          record(rule) &&
          Object.keys(rule).every(key =>
            ['action', 'resource', 'effect'].includes(key),
          ) &&
          typeof rule.action === 'string' &&
          rule.action.trim() &&
          rule.action.trim().length <= 120 &&
          typeof rule.resource === 'string' &&
          rule.resource.trim() &&
          rule.resource.trim().length <= 4096 &&
          ['allow', 'ask', 'deny'].includes(rule.effect),
      ))
  );
}
function validTools(value) {
  if (!record(value.agents)) return false;
  const agents = value.agents;
  return (
    Object.keys(value).every(key => ['agents', 'commit'].includes(key)) &&
    Object.keys(agents).every(key =>
      ['allowedModels', 'maxConcurrentAgents'].includes(key),
    ) &&
    (agents.allowedModels === null ||
      (Array.isArray(agents.allowedModels) &&
        agents.allowedModels.length <= 512 &&
        agents.allowedModels.every(
          model =>
            typeof model === 'string' &&
            model.length <= 512 &&
            /^[^/]+\/.+$/.test(model) &&
            !/[\s\p{Cc}\p{Cf}]/u.test(model),
        ))) &&
    (agents.maxConcurrentAgents === undefined ||
      (Number.isSafeInteger(agents.maxConcurrentAgents) &&
        agents.maxConcurrentAgents >= 1))
  );
}

/** Collect a disk/process snapshot. It has no access to a running Pi session. */
export async function collectDoctorReport({
  project = process.cwd(),
  root = applicationRoot,
  env = process.env,
  platform = process.platform,
} = {}) {
  project = await canonical(resolve(project));
  root = await canonical(root);
  env = Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => [
        platform === 'win32' ? name.toUpperCase() : name,
        value,
      ]),
  );
  const read = reader();
  const checks = [];
  const add = (id, status, summary, details = {}) => {
    const metadata = {...details};
    if (metadata.state === 'limited') {
      status = 'unknown';
      summary =
        'File contents were not inspected because a diagnostic read limit was reached.';
      delete metadata.fix;
    }
    checks.push({id, status, summary, ...metadata});
  };
  const unavailablePaths = names => ({
    formatVersion: 1,
    checks: [
      {
        id: 'locations.launch',
        status: 'unknown',
        summary:
          'The application launch directory is unavailable for these relative environment paths.',
        environmentNames: names,
      },
    ],
  });
  const initial = locations(env, platform, project);
  if (!isAbsolute(initial.environment))
    return unavailablePaths([
      platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CONFIG_HOME',
    ]);
  const savedEnvironment = await read(initial.environment);
  if (savedEnvironment.state === 'limited')
    return {
      formatVersion: 1,
      checks: [
        {
          id: 'environment.file',
          status: 'unknown',
          state: 'limited',
          summary:
            'Saved environment was not inspected because a diagnostic read limit was reached.',
        },
      ],
      limits: [
        'Effective environment values and profile paths cannot be determined without reading the saved environment. Remaining checks are unavailable.',
      ],
    };
  const saved =
    savedEnvironment.state === 'valid' &&
    Object.entries(savedEnvironment.value).every(
      ([name, value]) =>
        environmentField(platform === 'win32' ? name.toUpperCase() : name) &&
        typeof value === 'string' &&
        !value.includes('\0'),
    )
      ? Object.fromEntries(
          Object.entries(savedEnvironment.value).map(([name, value]) => [
            platform === 'win32' ? name.toUpperCase() : name,
            value,
          ]),
        )
      : {};
  const validEnvironment =
    savedEnvironment.state === 'missing' ||
    (savedEnvironment.state === 'valid' &&
      Object.keys(saved).length === Object.keys(savedEnvironment.value).length);
  add(
    'environment.file',
    validEnvironment ? 'ok' : 'error',
    validEnvironment
      ? 'Saved environment is absent or a valid object of configurable string values.'
      : 'Saved environment cannot be read as configurable string values.',
    {
      path: initial.environment,
      state: savedEnvironment.state,
      ...(!validEnvironment
        ? {
            fix: 'Repair this file or edit the affected entries in Menu → Environment.',
          }
        : {}),
    },
  );
  const effective = {...env, ...saved};
  const runtimeProfile = isAbsolute(env.VARISDEV_CODING_AGENT_DIR || '')
    ? env.VARISDEV_CODING_AGENT_DIR
    : undefined;
  const relativeLocations = [
    [
      'VARISDEV_SETTINGS_DIR',
      runtimeProfile ? undefined : effective.VARISDEV_SETTINGS_DIR,
    ],
    ['VARISDEV_DATA_DIR', effective.VARISDEV_DATA_DIR],
    ['PIDEV_DESKTOP_DATA_DIR', effective.PIDEV_DESKTOP_DATA_DIR],
    ...(!effective.VARISDEV_DATA_DIR && platform === 'linux'
      ? [['XDG_DATA_HOME', effective.XDG_DATA_HOME]]
      : []),
    ...(!effective.VARISDEV_DATA_DIR && platform === 'win32'
      ? [['LOCALAPPDATA', effective.LOCALAPPDATA]]
      : []),
  ]
    .filter(
      ([name, value]) =>
        (value || (name === 'PIDEV_DESKTOP_DATA_DIR' && value === '')) &&
        !isAbsolute(value) &&
        !(name === 'VARISDEV_SETTINGS_DIR' && /^~(?:[/\\]|$)/.test(value)),
    )
    .map(([name]) => name);
  if (relativeLocations.length) return unavailablePaths(relativeLocations);
  const paths = locations(
    runtimeProfile
      ? {...effective, VARISDEV_SETTINGS_DIR: runtimeProfile}
      : effective,
    platform,
    project,
  );
  if (runtimeProfile)
    add(
      'settings.profile',
      'info',
      'Settings paths use the inherited VarisDev runtime profile binding.',
      {
        path: paths.agent,
        source: 'VARISDEV_CODING_AGENT_DIR',
        activeSession: 'unverified',
      },
    );
  paths.environment = initial.environment;
  const workspace = await workspacePaths(project, paths.agent, paths.home);
  const sources = [
    {scope: 'global', directory: paths.agent},
    {
      scope: 'repository',
      directory: join(workspace.repository, '.varisdev'),
      requiresTrust: true,
    },
    ...(workspace.repository === project
      ? []
      : [
          {
            scope: 'current-folder',
            directory: join(project, '.varisdev'),
            requiresTrust: true,
          },
        ]),
    {scope: 'workspace', directory: workspace.workspace},
  ];
  const manifest = await read(join(root, 'package.json'));
  const isApp =
    manifest.state === 'valid' && manifest.value.name === 'varisdev';
  const schema = isApp ? await validators(root) : {};
  const resourcePath = (input, base) => {
    try {
      if (schema.resolvePath)
        return schema.resolvePath(input, base, {
          homeDir: paths.home,
          trim: true,
        });
      const path = input.trim();
      return expand(
        /^file:\/\//.test(path) ? fileURLToPath(path) : path,
        paths.home,
        base,
      );
    } catch {
      return undefined;
    }
  };
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(
    'runtime.node',
    nodeMajor >= 24 ? 'ok' : 'error',
    'Diagnostic Node runtime.',
    {
      version: process.versions.node,
      executable: process.execPath,
      minimumMajor: 24,
      ...(nodeMajor < 24
        ? {
            fix: 'Use Node 24 or newer and restart VarisDev from that installation.',
          }
        : {}),
    },
  );
  add(
    'installation.application',
    isApp && version(manifest.value.version) ? 'ok' : 'error',
    'Application containing this doctor skill.',
    {
      root,
      state: manifest.state,
      version: isApp ? version(manifest.value.version) || null : null,
      sourceCheckout: await exists(join(root, '.git')),
    },
  );
  for (const [name, packageName] of [
    ['pi', '@earendil-works/pi-coding-agent'],
    ['electron', 'electron'],
    ['npm', 'npm'],
  ]) {
    let result;
    let location;
    for (const prefix of ['desktop', '']) {
      location = join(
        root,
        prefix,
        'node_modules',
        packageName,
        'package.json',
      );
      result = await read(location);
      if (result.state !== 'missing') break;
    }
    add(
      `runtime.${name}`,
      result.state === 'valid' && version(result.value.version)
        ? 'ok'
        : 'warning',
      `Installed ${name} package metadata; executable not launched.`,
      {
        path: location,
        state: result.state,
        version:
          result.state === 'valid'
            ? version(result.value.version) || null
            : null,
      },
    );
  }
  const missingFiles = [];
  for (const file of [
    'bin/varisdev.mjs',
    'desktop/build/src/dashboard/parent.js',
    'desktop/node_modules/@earendil-works/pi-coding-agent/package.json',
  ])
    if (!(await exists(join(root, file)))) missingFiles.push(file);
  add(
    'installation.files',
    missingFiles.length ? 'warning' : 'ok',
    missingFiles.length
      ? 'Required launch/runtime files are missing from this application tree.'
      : 'Required launch/runtime files exist.',
    {
      missingFiles,
      ...(missingFiles.length
        ? {
            fix: 'In a source checkout, build/install the desktop runtime; for a packaged installation, repair or reinstall the intended installation.',
          }
        : {}),
    },
  );
  for (const name of ['varisdev', 'node', 'npm', 'git']) {
    const matches = await executables(name, effective, platform, project);
    const status = matches.length
      ? name === 'varisdev' && matches.length > 1
        ? 'warning'
        : 'ok'
      : name === 'git'
        ? 'info'
        : 'warning';
    add(
      `path.${name}`,
      status,
      matches.length
        ? 'Executable candidates in PATH order.'
        : 'No executable candidate found in the inspected PATH.',
      {
        matches,
        ...(status === 'warning'
          ? {
              fix:
                name === 'varisdev' && matches.length > 1
                  ? 'Choose the intended installation and remove or reorder obsolete PATH entries after confirming their ownership.'
                  : 'Check Menu → Environment and the launcher PATH; restart after correcting it.',
            }
          : {}),
      },
    );
  }
  if (
    (effective.PI_CODING_AGENT_DIR &&
      effective.PI_CODING_AGENT_DIR !== paths.agent) ||
    (effective.VARISDEV_CODING_AGENT_DIR &&
      effective.VARISDEV_CODING_AGENT_DIR !== paths.agent)
  )
    add(
      'settings.foreign-overrides',
      'info',
      'Pi/internal directory overrides do not select the VarisDev profile. VARISDEV_SETTINGS_DIR does.',
    );
  const environmentNames = [
    ...new Set([
      ...suggestedKeys,
      ...Object.keys(env).filter(environmentField),
      ...Object.keys(saved),
    ]),
  ].sort();
  add(
    'environment.sources',
    'info',
    'Names and sources only; saved values override inherited process values, including empty strings.',
    {
      variables: environmentNames.slice(0, 128).map(name => ({
        name,
        source: Object.hasOwn(saved, name)
          ? 'saved'
          : Object.hasOwn(env, name)
            ? 'inherited process'
            : 'absent',
        present: !!effective[name],
        ...(Object.hasOwn(saved, name)
          ? {
              inheritedPresence: Object.hasOwn(env, name)
                ? 'present (may already include the app overlay)'
                : 'absent',
            }
          : {}),
      })),
      omitted: Math.max(0, environmentNames.length - 128),
    },
  );
  add(
    'environment.launch',
    'unknown',
    'This helper sees its inherited process environment. Shell startup success, the original machine fallback, and another desktop process cannot be inferred.',
    {
      fix: 'Inspect Menu → Environment source labels in the affected app launch. Restart after changing shell startup or machine environment.',
    },
  );

  const settings = [];
  for (const source of sources) {
    const path = join(source.directory, 'settings.json');
    const result = await read(path);
    const input = result.value;
    const shape =
      result.state === 'valid' &&
      (!schema.settings || schema.settings(input)) &&
      (input.permissions === undefined ||
        validPermissions(input.permissions)) &&
      (input.default_agent === undefined ||
        typeof input.default_agent === 'string');
    const status =
      result.state === 'missing'
        ? 'ok'
        : !shape
          ? 'error'
          : schema.settings
            ? 'ok'
            : 'unknown';
    add(
      `settings.${source.scope}`,
      status,
      result.state === 'missing'
        ? 'No settings file in this scope.'
        : shape
          ? schema.settings
            ? 'Settings match the shipped schema and VarisDev shared fields.'
            : 'JSON object parsed; the shipped schema is unavailable.'
          : 'Settings are malformed or contain an invalid field type.',
      {
        path,
        state: result.state,
        ...(source.requiresTrust ? {requiresProjectTrust: true} : {}),
        ...(!shape && result.state !== 'missing'
          ? {
              fix: 'Repair the indicated settings file; preserve unrelated fields and credentials.',
            }
          : {}),
      },
    );
    settings.push({
      ...source,
      path,
      value: result.state === 'valid' ? input : {},
    });
  }
  const knownFields = new Set([
    'defaultProvider',
    'defaultModel',
    'defaultThinkingLevel',
    'transport',
    'theme',
    'compaction',
    'retry',
    'packages',
    'extensions',
    'skills',
    'prompts',
    'themes',
    'enabledModels',
    'defaultTools',
    'permissions',
    'default_agent',
    'enableSkillCommands',
    'shellPath',
  ]);
  const overrides = [];
  for (let high = 1; high < settings.length; high++)
    for (let low = 0; low < high; low++) {
      const fields = Object.keys(settings[high].value).filter(
        key =>
          knownFields.has(key) &&
          Object.hasOwn(settings[low].value, key) &&
          JSON.stringify(settings[low].value[key]) !==
            JSON.stringify(settings[high].value[key]),
      );
      if (fields.length)
        overrides.push({
          lower: settings[low].scope,
          higher: settings[high].scope,
          fields,
        });
    }
  add(
    'settings.precedence',
    'info',
    'Preferences: global < trusted repository < trusted current-folder < personal workspace. Objects merge; resources accumulate with their own filtering and precedence; shared permissions accumulate.',
    {overrides},
  );
  const trust = await read(join(paths.agent, 'trust.json'));
  let savedTrust = trust.state === 'limited' ? 'unavailable' : 'unset';
  if (trust.state === 'valid') {
    for (let directory = project; ; directory = dirname(directory)) {
      const entry = Object.entries(trust.value).find(
        ([key, value]) =>
          resolve(key) === directory && typeof value === 'boolean',
      );
      if (entry) {
        savedTrust = entry[1] ? 'trusted' : 'untrusted';
        break;
      }
      if (dirname(directory) === directory) break;
    }
  }
  const validTrust =
    trust.state === 'missing' ||
    (trust.state === 'valid' &&
      Object.values(trust.value).every(
        value => value === null || typeof value === 'boolean',
      ));
  add(
    'settings.trust',
    validTrust ? 'info' : 'error',
    'Saved trust is a disk observation; the active session may have a different trust decision.',
    {
      path: join(paths.agent, 'trust.json'),
      state: trust.state,
      savedDecision: savedTrust,
      activeSession: 'unavailable',
    },
  );
  for (const file of [
    join(paths.home, '.varisdev', 'settings.json'),
    join(project, '.pi', 'settings.json'),
  ]) {
    if (file !== join(paths.agent, 'settings.json') && (await exists(file)))
      add(
        'settings.other-location',
        'info',
        'Settings also exist outside the selected profile. Legacy flat settings are migration inputs; .pi belongs to standalone Pi.',
        {path: file},
      );
  }
  const models = await read(
    join(paths.agent, 'models.json'),
    true,
    schema.stripJsonComments,
  );
  add(
    'settings.models',
    models.state === 'missing'
      ? 'ok'
      : models.state === 'schema-unavailable'
        ? 'unknown'
        : models.state === 'valid' && schema.models?.(models.value)
          ? 'ok'
          : 'error',
    'Global models.json uses the shipped model schema, including line comments and trailing commas. No key expressions are resolved.',
    {path: join(paths.agent, 'models.json'), state: models.state},
  );
  const toolSettings = await read(
    join(paths.agent, 'varisdev/tool-settings.json'),
  );
  add(
    'settings.tools',
    toolSettings.state === 'missing' ||
      (toolSettings.state === 'valid' && validTools(toolSettings.value))
      ? 'ok'
      : 'error',
    'Agent tool settings checked; retired commit settings are ignored as in the app.',
    {
      path: join(paths.agent, 'varisdev/tool-settings.json'),
      state: toolSettings.state,
    },
  );
  const desktop = await read(join(paths.desktop, 'settings.json'));
  add(
    'settings.desktop',
    ['missing', 'valid'].includes(desktop.state) ? 'ok' : 'warning',
    'Desktop preference file checked as a JSON object; individual preferences may fall back to defaults.',
    {path: join(paths.desktop, 'settings.json'), state: desktop.state},
  );

  const auth = await read(join(paths.agent, 'auth.json'));
  const credentials = [];
  let invalidAuth = !['valid', 'missing'].includes(auth.state);
  for (const [index, credential] of Object.values(auth.value || {}).entries()) {
    if (index >= 128) break;
    const apiKey =
      record(credential) &&
      credential.type === 'api_key' &&
      (credential.key === undefined || typeof credential.key === 'string') &&
      (credential.env === undefined || strings(credential.env));
    const oauth =
      record(credential) &&
      credential.type === 'oauth' &&
      typeof credential.access === 'string' &&
      typeof credential.refresh === 'string' &&
      Number.isFinite(credential.expires);
    if (!apiKey && !oauth) invalidAuth = true;
    credentials.push({
      entry: index + 1,
      kind: apiKey ? 'api_key' : oauth ? 'oauth' : 'invalid',
      ...(apiKey
        ? {
            key: !credential.key
              ? 'absent'
              : credential.key.startsWith('!')
                ? 'command (not evaluated)'
                : schema.referenceNames?.(credential.key).length
                  ? 'reference (not evaluated)'
                  : 'present',
          }
        : {}),
      ...(oauth
        ? {
            access: credential.access ? 'present' : 'absent',
            refresh: credential.refresh ? 'present' : 'absent',
            expired: credential.expires <= Date.now(),
          }
        : {}),
    });
  }
  add(
    'auth.presence',
    invalidAuth ? 'error' : 'info',
    'Credential presence only. OAuth may refresh; presence does not verify sign-in, provider access, or plugin authentication.',
    {
      path: join(paths.agent, 'auth.json'),
      state: auth.state,
      credentials,
      omitted: Math.max(0, Object.keys(auth.value || {}).length - 128),
    },
  );
  add(
    'auth.plugin-contracts',
    'info',
    'Plugins may use separate API keys or credentials. Saved OAuth does not establish that OPENAI_API_KEY or any plugin-specific key is present.',
  );

  for (const source of settings) {
    const packages = source.value.packages;
    if (Array.isArray(packages))
      for (const [index, item] of packages.slice(0, 32).entries()) {
        const spec =
          typeof item === 'string'
            ? item
            : record(item)
              ? item.source
              : undefined;
        if (typeof spec !== 'string' || !spec.trim()) {
          add('plugins.entry', 'error', 'Invalid package source.', {
            scope: source.scope,
            entry: index + 1,
          });
          continue;
        }
        const kind = spec.startsWith('npm:')
          ? 'npm'
          : /^(?:git:|git\+|https?:|ssh:|git@|github:)/.test(spec)
            ? 'git/remote'
            : 'local';
        const localExists =
          kind === 'local'
            ? await exists(resourcePath(spec, source.directory))
            : undefined;
        add(
          'plugins.entry',
          localExists === false ? 'warning' : 'info',
          kind === 'local'
            ? 'Local package path checked without loading it.'
            : 'Package registration found; installation/version not verified offline.',
          {
            scope: source.scope,
            entry: index + 1,
            kind,
            ...(localExists === undefined ? {} : {exists: localExists}),
            ...(localExists === false
              ? {
                  fix: 'Correct this package entry or restore its local directory, then /reload.',
                }
              : {}),
          },
        );
      }
    for (const kind of ['extensions', 'skills', 'prompts', 'themes']) {
      const entries = source.value[kind];
      if (!Array.isArray(entries)) continue;
      for (const [index, item] of entries.slice(0, 32).entries()) {
        if (typeof item !== 'string') continue;
        if (
          /^[+!-]?builtin:/.test(item) ||
          /^[+!-]/.test(item) ||
          /[*?[\]{}]/.test(item)
        )
          continue;
        if (!(await exists(resourcePath(item, source.directory))))
          add(
            'plugins.resource-path',
            'warning',
            'An explicitly configured resource path is missing.',
            {
              scope: source.scope,
              resource: kind,
              entry: index + 1,
              fix: 'Correct or remove this resource entry, then /reload.',
            },
          );
      }
    }
  }
  add(
    'plugins.runtime',
    'unknown',
    'Plugin imports, hooks, dynamic registrations, remote package versions, and load errors require the affected running session. No plugin code was executed.',
  );

  const mcpServers = new Map();
  const globalServers = new Map();
  let globalDefinitionsKnown = false;
  for (const source of sources) {
    const path = join(source.directory, 'mcp.json');
    const config = await read(path);
    const valid =
      config.state === 'valid' &&
      (config.value.mcpServers === undefined ||
        record(config.value.mcpServers)) &&
      (config.value.autoEnableCodemode === undefined ||
        typeof config.value.autoEnableCodemode === 'boolean');
    add(
      `mcp.${source.scope}`,
      config.state === 'missing' ? 'ok' : valid ? 'info' : 'error',
      'MCP configuration read without connecting servers or evaluating commands.',
      {
        path,
        state: config.state,
        ...(source.requiresTrust ? {requiresProjectTrust: true} : {}),
      },
    );
    if (source.scope === 'global')
      globalDefinitionsKnown = config.state === 'missing';
    if (!valid) continue;
    const namespaceNames = new Set();
    const servers = record(config.value.mcpServers)
      ? Object.entries(config.value.mcpServers)
      : [];
    if (source.scope === 'global')
      globalDefinitionsKnown = servers.length <= 64;
    for (const [index, [name, raw]] of servers.slice(0, 64).entries()) {
      const partial =
        source.requiresTrust &&
        record(raw) &&
        raw.command === undefined &&
        raw.url === undefined &&
        raw.type === undefined;
      const base = globalServers.get(name);
      if (partial && !base && !globalDefinitionsKnown) {
        add(
          'mcp.entry',
          'unknown',
          'Project override cannot be checked without an inspected, valid global server definition.',
          {scope: source.scope, entry: index + 1},
        );
        continue;
      }
      const input = partial && base ? {...base, ...raw} : raw;
      const invalidOverride =
        partial &&
        (!base ||
          Object.keys(raw).some(
            key => !['enabled', 'exposure', 'toolExposure'].includes(key),
          ));
      const validated = schema.mcp ? schema.mcp(name, input) : undefined;
      const invalid =
        invalidOverride ||
        typeof validated === 'string' ||
        !record(input) ||
        (source.requiresTrust &&
          record(input) &&
          input.auth !== undefined &&
          !partial);
      if (source.scope === 'global' && invalid) globalDefinitionsKnown = false;
      const namespace = name.replaceAll('-', '_');
      const conflict =
        namespaceNames.has(namespace) ||
        [...mcpServers.keys()].some(
          other => other !== name && other.replaceAll('-', '_') === namespace,
        );
      if (!invalid && record(input)) {
        mcpServers.set(name, input);
        if (source.scope === 'global') globalServers.set(name, input);
      }
      namespaceNames.add(namespace);
      const fields = record(input)
        ? [
            ...Object.values(record(input.env) ? input.env : {}),
            ...Object.values(record(input.headers) ? input.headers : {}),
            ...(record(input.oauth) ? [input.oauth.clientSecret] : []),
          ].filter(value => typeof value === 'string')
        : [];
      const references = [
        ...new Set(
          fields.flatMap(value =>
            schema.referenceNames ? schema.referenceNames(value) : [],
          ),
        ),
      ];
      // MCP env entries are each resolved against the process, not one another.
      const missing = references.filter(name => !effective[name]);
      add(
        'mcp.entry',
        invalid || conflict
          ? 'error'
          : missing.length
            ? 'warning'
            : schema.mcp
              ? 'info'
              : 'unknown',
        invalid
          ? 'Invalid server entry or unsupported project override/provider authentication.'
          : conflict
            ? 'Server names collide after hyphens become underscores.'
            : 'Server configuration checked; connection and authentication are unverified.',
        {
          scope: source.scope,
          entry: index + 1,
          enabled: record(input) && input.enabled !== false,
          transport:
            record(input) && typeof input.url === 'string' ? 'http' : 'stdio',
          ...(fields.some(value => value.startsWith('!'))
            ? {commandValues: 'not evaluated'}
            : {}),
          missingEnvironmentNames: missing.filter(keyName).slice(0, 32),
          ...(invalid || conflict
            ? {
                fix: 'Repair this entry in the indicated mcp.json; project partial overrides need a global base, and workspace entries need complete definitions.',
              }
            : {}),
        },
      );
    }
    if (servers.length > 64)
      add(
        'mcp.limit',
        'unknown',
        'Additional MCP entries omitted by the diagnostic limit.',
        {scope: source.scope, omitted: servers.length - 64},
      );
  }
  add(
    'mcp.live',
    'unknown',
    'Use the affected session’s existing /mcp interface for live state. varisdev mcp list connects servers and is outside this offline check.',
  );

  for (const [kind, path] of [
    ['data', paths.data],
    ['settings', paths.agent],
    ['installation', root],
  ]) {
    const writable = await writableAncestor(path);
    add(
      `permissions.${kind}`,
      writable ? 'ok' : 'warning',
      'Write/search access checked on this directory or its nearest existing parent; no file was created.',
      {
        path,
        writable,
        ...(!writable
          ? {
              fix: 'Restore access for the current user or choose an owned installation/profile location; review the exact path before changing permissions.',
            }
          : {}),
      },
    );
  }
  const pointerPath = join(paths.data, 'active.json');
  const pointer = await read(pointerPath);
  if (pointer.state === 'valid') {
    const value = pointer.value;
    const valid =
      typeof value.generation === 'string' &&
      /^(?:runtime-\d+\.\d+\.\d+-[a-f0-9-]+|app-[a-f0-9]{16})$/.test(
        value.generation,
      ) &&
      typeof value.baseRoot === 'string' &&
      isAbsolute(value.baseRoot) &&
      version(value.version) &&
      typeof value.fingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(value.fingerprint);
    const target = valid
      ? value.generation.startsWith('app-')
        ? join(
            paths.data,
            'runtimes',
            value.generation,
            platform === 'win32' ? 'node_modules' : 'lib/node_modules',
            'varisdev',
          )
        : join(paths.data, 'runtimes', value.generation)
      : undefined;
    const targetExists = target
      ? await exists(join(target, 'desktop/build/src/dashboard/parent.js'))
      : false;
    add(
      'updates.activation',
      valid && targetExists ? 'info' : 'warning',
      valid && targetExists
        ? 'An activation candidate exists. Fingerprint compatibility and the active session generation are unverified.'
        : 'Saved update activation is malformed or its built runtime is missing; the launcher may use the base installation.',
      {
        path: pointerPath,
        ...(valid
          ? {version: value.version, target, builtRuntimeExists: targetExists}
          : {}),
        ...(!valid || !targetExists
          ? {
              fix: 'Check update status in the app. Review the pointer and installation before repairing or reinstalling.',
            }
          : {}),
      },
    );
  } else
    add(
      'updates.activation',
      pointer.state === 'missing' ? 'info' : 'warning',
      pointer.state === 'missing'
        ? 'No saved runtime activation pointer.'
        : 'The saved runtime activation pointer cannot be parsed.',
      {path: pointerPath, state: pointer.state},
    );
  if (await exists(join(paths.data, 'update.lock')))
    add(
      'updates.lock',
      'info',
      'An update lock exists. It may belong to a running updater; do not delete it based on this observation alone.',
      {path: join(paths.data, 'update.lock')},
    );
  add(
    'updates.latest',
    'unknown',
    'Latest release and restart requirement are not checked offline. Read the app’s update status for the affected running version.',
  );
  add(
    'context.live',
    'unknown',
    'Disk files cannot measure the active session. Use Pi /context where available and the app’s Context/Tokens information for loaded instructions, skills, tools, context use, and limits.',
  );
  const limits = [
    'Offline snapshot only; no network requests, commands, shell startup, plugin imports, MCP connections, credential resolution, config writes, or file creation.',
    'At most 160 JSON files, 512 KiB per file, 8 MiB total; 128 PATH directories and eight matches per executable; 32 package/resource entries per scope and 64 MCP entries per scope.',
    'Saved environment sources are known only for the located file. Inherited values may already contain VarisDev overlays; live shell/machine fallback and session trust are unavailable.',
    'Context occupancy, loaded skill/instruction overhead, plugin health, MCP connections, OAuth validity, latest release, filesystem locks/ACL behavior, and restart requirements need live application evidence.',
  ];
  // Only metadata is returned. User-controlled config values and parser/validator messages never enter the report.
  const report = {
    formatVersion: 1,
    project,
    installationRoot: root,
    paths: {
      settings: paths.agent,
      workspace: workspace.workspace,
      repository: workspace.repository,
      environment: paths.environment,
      data: paths.data,
      desktop: paths.desktop,
    },
    checks,
    limits,
  };
  const secrets = new Set(
    Object.entries(env)
      .filter(
        ([name, value]) =>
          /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH/i.test(name) &&
          value.length >= 4,
      )
      .map(([, value]) => value),
  );
  for (const value of Object.values(saved))
    if (value.length >= 4) secrets.add(value);
  // Path metadata may contain a credential from a misconfigured environment value.
  const orderedSecrets = [...secrets].sort((a, b) => b.length - a.length);
  const redact = value =>
    typeof value === 'string'
      ? orderedSecrets.reduce(
          (text, secret) => text.split(secret).join('[redacted]'),
          value,
        )
      : Array.isArray(value)
        ? value.map(redact)
        : record(value)
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, redact(item)]),
            )
          : value;
  const output = redact(report);
  let omittedChecks = 0;
  while (
    JSON.stringify(output).length > 128 * 1024 &&
    output.checks.length > 40
  ) {
    output.checks.splice(25, 1);
    omittedChecks++;
  }
  if (omittedChecks)
    output.checks.push({
      id: 'diagnostic.output-limit',
      status: 'unknown',
      summary: 'Additional check details omitted to bound the report size.',
      omitted: omittedChecks,
    });
  return output;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length &&
    !(args.length === 2 && args[0] === '--project' && args[1])
  ) {
    console.error('Usage: node diagnose.mjs [--project <directory>]');
    process.exitCode = 2;
    return;
  }
  // No children are started. This also bounds filesystem waits/import failures.
  const deadline = setTimeout(() => {
    console.log(
      JSON.stringify({
        formatVersion: 1,
        checks: [
          {
            id: 'diagnostic.deadline',
            status: 'unknown',
            summary:
              'Doctor stopped after its 12 second deadline; remaining checks are unavailable.',
          },
        ],
      }),
    );
    process.exit(2);
  }, 12000);
  try {
    const report = await collectDoctorReport({project: args[1]});
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.log(
      JSON.stringify({
        formatVersion: 1,
        checks: [
          {
            id: 'diagnostic.failure',
            status: 'unknown',
            summary:
              'Doctor could not complete the local snapshot. No configuration was changed.',
          },
        ],
      }),
    );
    process.exitCode = 2;
  } finally {
    clearTimeout(deadline);
  }
}
if (process.argv[1] && (await canonical(process.argv[1])) === modulePath)
  await main();
