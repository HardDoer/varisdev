import {initializeEnvironment} from './environment.mjs';

await initializeEnvironment();
await import('./headless-session.ts');
