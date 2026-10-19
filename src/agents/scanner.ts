import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {isAbsolute, resolve} from 'node:path';
import {getPowerShellConfig} from '@earendil-works/pi-coding-agent';
import type {SyntaxNode, Word, WordPart} from 'unbash';

const MAX_SOURCE = 16_384;
const MAX_NODES = 8_192;
const MAX_DEPTH = 64;

export interface AgentShellScan {
  commands: Array<{resource: string; aliases: readonly string[]}>;
  paths: string[];
}

interface ScanContext {
  source: string;
  cwd: string;
}

function staticParts(parts: readonly WordPart[] | undefined): boolean {
  return (
    !parts ||
    parts.every(part => {
      switch (part.type) {
        case 'Literal':
        case 'SingleQuoted':
        case 'AnsiCQuoted':
          return true;
        case 'DoubleQuoted':
          return staticParts(part.parts);
        default:
          return false;
      }
    })
  );
}

function literal(word: Word | undefined): string | undefined {
  return word && staticParts(word.parts) ? word.value : undefined;
}

function staticPath(value: string, cwd: string): string | undefined {
  if (!value || value === '-' || /^[a-z][a-z\d+.-]*:\/\//i.test(value))
    return undefined;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\'))
    return resolve(homedir(), value.slice(2));
  return resolve(cwd, value);
}

function inferPaths(
  name: string | undefined,
  args: readonly (string | undefined)[],
  context: ScanContext,
  paths: Set<string>,
): string | undefined {
  const command = name?.toLowerCase();
  const directoryCommand = [
    'cd',
    'pushd',
    'set-location',
    'sl',
    'chdir',
    'push-location',
  ].includes(command ?? '');
  const positional = args.filter(value => value !== '--');
  if (directoryCommand) {
    const destination = positional.find(
      value => value !== undefined && !value.startsWith('-'),
    );
    const path =
      destination === undefined && args.length === 0
        ? homedir()
        : destination === undefined
          ? undefined
          : staticPath(destination, context.cwd);
    if (path) paths.add(path);
    return path;
  }
  if (name && (isAbsolute(name) || name.includes('/') || name.includes('\\'))) {
    const path = staticPath(name, context.cwd);
    if (path) paths.add(path);
  }
  // Output strings and patterns do not themselves name accessed files.
  if (['echo', 'printf', 'write-output', 'write-host'].includes(command ?? ''))
    return undefined;
  for (const argument of args) {
    if (argument === undefined || argument.startsWith('-')) {
      const directory = argument?.match(/^--[^=]+=(.+)$/)?.[1];
      const path = directory && staticPath(directory, context.cwd);
      if (path) paths.add(path);
      continue;
    }
    const path = staticPath(argument, context.cwd);
    if (path) paths.add(path);
  }
  return undefined;
}

async function scanBash(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentShellScan> {
  const {parse, forEachChild} = await import('unbash');
  signal?.throwIfAborted();
  const commands: AgentShellScan['commands'] = [];
  const paths = new Set<string>();
  let count = 0;
  const visit = (
    node: SyntaxNode,
    context: ScanContext,
    depth: number,
  ): void => {
    signal?.throwIfAborted();
    if (++count > MAX_NODES || depth > MAX_DEPTH)
      throw new Error('Shell permission scan exceeded its syntax limit.');
    if (node.type === 'Script') {
      if (node.errors?.length)
        throw new Error(
          `Shell permission scan could not parse Bash: ${node.errors[0].message}`,
        );
      context = {...context, source: node.source ?? context.source};
    }
    let nextDirectory: string | undefined;
    if (node.type === 'Command') {
      const parts = [
        ...node.prefix,
        ...(node.name ? [node.name] : []),
        ...node.suffix,
      ].sort((a, b) => a.pos - b.pos);
      commands.push({
        resource: context.source.slice(node.pos, node.end),
        aliases: [
          parts
            .map(part =>
              part.type === 'Word'
                ? part.value
                : context.source.slice(part.pos, part.end),
            )
            .join(' '),
        ],
      });
      nextDirectory = inferPaths(
        literal(node.name),
        node.args.map(arg => (arg.type === 'Word' ? literal(arg) : undefined)),
        context,
        paths,
      );
    } else if (node.type === 'Redirect' && node.target) {
      const target = literal(node.target);
      if (
        target !== undefined &&
        !(['<&', '>&'].includes(node.operator) && /^(?:\d+|-)$/.test(target))
      ) {
        const path = staticPath(target, context.cwd);
        if (path) paths.add(path);
      }
    } else if (
      (node.type === 'CommandExpansion' ||
        node.type === 'ProcessSubstitution' ||
        node.type === 'ArithmeticCommandExpansion') &&
      !node.script
    ) {
      throw new Error(
        'Shell permission scan could not parse a nested shell script.',
      );
    }
    // Nested scripts and separate execution branches do not change their parent's directory.
    const separate = [
      'Command',
      'Pipeline',
      'If',
      'Elif',
      'For',
      'ArithmeticFor',
      'Select',
      'While',
      'Case',
      'Function',
      'Coproc',
      'Subshell',
      'CommandExpansion',
      'ProcessSubstitution',
      'ArithmeticCommandExpansion',
    ].includes(node.type);
    forEachChild(node, child =>
      visit(child, separate ? {...context} : context, depth + 1),
    );
    if (nextDirectory) context.cwd = nextDirectory;
  };
  visit(parse(source), {source, cwd}, 0);
  return {commands, paths: [...paths]};
}

// Only this fixed program is executed. Command source is read as data from stdin.
const POWERSHELL_PARSER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$nodes = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -or $node -is [System.Management.Automation.Language.FileRedirectionAst] -or $node -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))
$items = @($nodes | ForEach-Object {
  $depth = 0
  for ($parent = $_.Parent; $null -ne $parent; $parent = $parent.Parent) { $depth++; if ($depth -gt 64) { throw 'Shell permission scan exceeded its syntax limit.' } }
  if ($_ -is [System.Management.Automation.Language.CommandAst]) {
    $elements = @((@($_.CommandElements) + @($_.Redirections)) | Sort-Object { $_.Extent.StartOffset } | ForEach-Object {
      $value = $null
      if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $value = $_.Value }
      elseif ($_ -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and $_.NestedExpressions.Count -eq 0) { $value = $_.Value }
      @{value=$value; text=$_.Extent.Text}
    })
    @{kind='command'; text=$_.Extent.Text; name=$_.GetCommandName(); elements=$elements}
  } elseif ($_ -is [System.Management.Automation.Language.AssignmentStatementAst]) {
    @{kind='operation'; text=$_.Extent.Text}
  } else {
    $target = $null
    if ($_.Location -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $target = $_.Location.Value }
    @{kind='redirect'; target=$target}
  }
})
@{errors=@($errors | ForEach-Object { $_.Message }); items=$items} | ConvertTo-Json -Depth 8 -Compress
`;

async function scanPowerShell(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentShellScan> {
  const shell =
    process.platform === 'win32' ? getPowerShellConfig().shell : 'pwsh';
  const output = await new Promise<string>((fulfill, reject) => {
    const child = spawn(
      shell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(POWERSHELL_PARSER, 'utf16le').toString('base64'),
      ],
      {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let text = '';
    let errorText = '';
    const kill = () => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else child.kill('SIGKILL');
    };
    const stop = (error: Error) => {
      kill();
      reject(error);
    };
    const abort = () =>
      stop(new Error('PowerShell permission scan cancelled.'));
    const timer = setTimeout(
      () => stop(new Error('PowerShell permission scan timed out.')),
      5_000,
    );
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      text += data.toString();
      if (text.length > 1_048_576)
        stop(
          new Error('PowerShell permission scan exceeded its output limit.'),
        );
    });
    child.stderr.on('data', data => {
      errorText = (errorText + data.toString()).slice(-2_048);
    });
    child.stdin.on('error', () => {});
    child.on('error', error =>
      reject(
        new Error(
          `PowerShell permission scanning requires an installed native parser: ${error.message}`,
        ),
      ),
    );
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code !== 0)
        reject(
          new Error(`PowerShell permission scan failed: ${errorText || code}`),
        );
      else fulfill(text);
    });
    child.stdin.end(source);
  });
  const parsed = JSON.parse(output.replace(/^\uFEFF/, '')) as {
    errors?: string[];
    items?: Array<{
      kind: string;
      text?: string;
      name?: string;
      elements?: Array<{value: string | null; text: string}>;
      target?: string;
    }>;
  };
  if (parsed.errors?.length)
    throw new Error(
      `Shell permission scan could not parse PowerShell: ${parsed.errors[0]}`,
    );
  if ((parsed.items?.length ?? 0) > MAX_NODES)
    throw new Error('Shell permission scan exceeded its syntax limit.');
  const commands: AgentShellScan['commands'] = [];
  const paths = new Set<string>();
  const context = {source, cwd};
  for (const item of parsed.items ?? []) {
    if (item.kind === 'command' && item.text) {
      const elements = item.elements ?? [];
      commands.push({
        resource: item.text,
        aliases: [
          elements.map(element => element.value ?? element.text).join(' '),
        ],
      });
      const directory = inferPaths(
        item.name,
        elements.slice(1).map(element => element.value ?? undefined),
        context,
        paths,
      );
      if (directory) context.cwd = directory;
    } else if (item.kind === 'operation' && item.text) {
      commands.push({resource: item.text, aliases: []});
    } else if (item.kind === 'redirect' && item.target) {
      const path = staticPath(item.target, context.cwd);
      if (path) paths.add(path);
    }
  }
  return {commands, paths: [...paths]};
}

/** Inspect syntax only; runtime expansions and programs remain outside this scan. */
export async function scanAgentShell(
  toolName: 'bash' | 'powershell',
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentShellScan> {
  signal?.throwIfAborted();
  if (command.length > MAX_SOURCE)
    throw new Error(
      `Shell permission scan accepts at most ${MAX_SOURCE} characters.`,
    );
  return toolName === 'powershell'
    ? scanPowerShell(command, cwd, signal)
    : scanBash(command, cwd, signal);
}
