// Exercise Pi's real interactive startup and shutdown with captured terminal IO.
// The fake terminal avoids sending capability or mouse sequences to the test runner.
import process from 'node:process';
import {main} from '@earendil-works/pi-coding-agent';

Object.defineProperty(process.stdin, 'isTTY', {value: true});
Object.defineProperty(process.stdout, 'isTTY', {value: true});
process.stdin.setRawMode = () => process.stdin;
process.stdout.columns = 120;
process.stdout.rows = 35;
await main(process.argv.slice(2));
