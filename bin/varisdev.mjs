#!/usr/bin/env node
import {fileURLToPath, pathToFileURL, URL} from 'node:url';
import {join} from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {requireNode24} from '../src/runtime/node-version.mjs';

requireNode24();
const installRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const {initializeEnvironment} =
    await import('../src/runtime/environment.mjs');
  await initializeEnvironment();
  const {RuntimeManager} =
    await import('../desktop/build/src/runtime/manager.js');
  const root = await new RuntimeManager({installRoot}).currentRoot();
  const {runCli} = await import(
    pathToFileURL(join(root, 'desktop/build/src/runtime/cli.js')).href
  );
  process.exitCode = await runCli(process.argv.slice(2), installRoot);
} catch (error) {
  console.error(`VarisDev: ${error.message || String(error)}`);
  process.exitCode = 1;
}
