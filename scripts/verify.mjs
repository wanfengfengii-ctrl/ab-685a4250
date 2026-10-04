#!/usr/bin/env node
/**
 * One-shot verification entry point for the `verify` Compose service.
 *
 * Runs in order and aggregates exit codes into its own exit code:
 *   1. TypeScript build (`tsc -p tsconfig.json`, strict)
 *   2. code tests (compiled output run under node's built-in test runner)
 *   3. submit/query smoke against the live API (BASE_URL, waited to healthy)
 *
 * Exit code bits:
 *   bit 0 (1) -> build failed
 *   bit 1 (2) -> tests failed
 *   bit 2 (4) -> smoke failed
 * so 0 means everything passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(label, cmd, args) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label}: ${cmd} ${args.join(' ')} ===`);
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      console.log(`=== ${label} exited with code ${code ?? 'null'} ===`);
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      console.error(`=== ${label} failed to start: ${err.message} ===`);
      resolve(1);
    });
  });
}

const tscBin = join(root, 'tools', 'node_modules', 'typescript', 'bin', 'tsc');
const nodeBin = process.execPath;

const buildCode = await run('typescript build', nodeBin, [tscBin, '-p', 'tsconfig.json']);
const testCode = buildCode === 0
  ? await run('code tests', nodeBin, ['--test', ...['crypto', 'validation', 'e2e'].map((n) => join('dist', 'test', `${n}.test.js`))])
  : 1;
const smokeCode = buildCode === 0
  ? await run('submit/query smoke', nodeBin, [join('scripts', 'smoke.mjs')])
  : 1;

const summary =
  (buildCode !== 0 ? 1 : 0) |
  (testCode !== 0 ? 2 : 0) |
  (smokeCode !== 0 ? 4 : 0);

console.log('\n=== verify summary ===');
console.log(`build: ${buildCode === 0 ? 'PASS' : 'FAIL'}`);
console.log(`tests: ${testCode === 0 ? 'PASS' : 'FAIL'}`);
console.log(`smoke: ${smokeCode === 0 ? 'PASS' : 'FAIL'}`);
console.log(`verify exit code: ${summary}`);
process.exit(summary);
