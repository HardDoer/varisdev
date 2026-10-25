import {requireNode24} from './node-version.mjs';

requireNode24();
const {initializeEnvironment} = await import('./environment.mjs');
await initializeEnvironment();
await import('./headless-session.ts');
