import {initializeEnvironment} from '../runtime/environment.mjs';

await initializeEnvironment();
await import('./application.ts');
