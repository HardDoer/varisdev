/* global console, process */
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const [installer, ...args] = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const failure = process.env.VARISDEV_TEST_PROMOTION_FAILURE;
if (failure) {
  const root = join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    'varisdev',
  );
  const bin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const target = failure === 'package' ? root : join(bin, failure);
  const rename = fs.rename;
  let failed = false;
  fs.rename = async (source, destination) => {
    if (
      !failed &&
      String(source).includes(`${sep}stage${sep}`) &&
      destination === target
    ) {
      failed = true;
      throw Object.assign(new Error('Injected promotion failure'), {
        code: 'EACCES',
      });
    }
    if (
      failed &&
      process.env.VARISDEV_TEST_ROLLBACK_FAILURE &&
      String(source).includes('previous') &&
      destination === root
    )
      throw Object.assign(new Error('Injected rollback failure'), {
        code: 'EACCES',
      });
    return rename(source, destination);
  };
  syncBuiltinESMExports();
}
try {
  const {install} = await import(pathToFileURL(installer).href);
  await install(args);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
