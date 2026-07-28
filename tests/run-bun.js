'use strict';
import { spawn } from 'node:child_process';
import setup from './setup.js';
import teardown from './teardown.js';

const args = process.argv.slice(2);

await setup();

const exitCode = await new Promise(resolve => {
  const child = spawn(
    'bun',
    ['test', '--timeout', '220000', '--parallel', '8', '--isolate', '--bail', ...args],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  child.on('close', resolve);
});

await teardown();

process.exit(exitCode);
