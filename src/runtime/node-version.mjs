import console from 'node:console';
import process from 'node:process';

/** Check before importing the application or its dependencies. */
export function requireNode24() {
  if (Number.parseInt(process.versions.node, 10) >= 24) return;
  console.error(`VarisDev requires Node 24+ (running ${process.version}).`);
  process.exit(1);
}
