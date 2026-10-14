// Exercise Pi's real interactive startup and shutdown with captured terminal IO.
// The fake terminal avoids sending capability or mouse sequences to the test runner.
import process from 'node:process';
import {URL} from 'node:url';

Object.defineProperty(process.stdin, 'isTTY', {value: true});
Object.defineProperty(process.stdout, 'isTTY', {value: true});
process.stdin.setRawMode = () => process.stdin;
process.stdout.columns = 120;
process.stdout.rows = 35;
await import(
  process.env.PI_TEST_CLI ??
    new URL(
      './bundle/cli.js',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    ).href
);
