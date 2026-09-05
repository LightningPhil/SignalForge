import { spawnSync } from 'node:child_process';
import path from 'node:path';

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/bench/scale-1m.test.ts'],
  {
    cwd: process.cwd(),
    env: { ...process.env, SIGNALFORGE_LAB_1M: '1' },
    stdio: 'inherit',
    windowsHide: true
  }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
