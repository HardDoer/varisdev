import {requireNode24} from '../runtime/node-version.mjs';

requireNode24();
const {initializeEnvironment} = await import('../runtime/environment.mjs');
await initializeEnvironment();
await import('./application.ts');
