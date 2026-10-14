#!/usr/bin/env node
import {fileURLToPath, URL} from 'node:url';
import process from 'node:process';
import console from 'node:console';

const installRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const {runCli} = await import('../desktop/build/src/runtime/cli.js');
  process.exitCode = await runCli(process.argv.slice(2), installRoot);
} catch (error) {
  console.error(`VarisDev: ${error.message || String(error)}`);
  process.exitCode = 1;
}
