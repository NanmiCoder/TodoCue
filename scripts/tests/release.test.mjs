import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRelease, nextVersion, prepareRelease } from '../release.mjs';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
function git(directory, ...args) { return execFileSync('git', args, { cwd: directory, env: gitEnv, encoding: 'utf8' }).trim(); }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todocue-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file, contents) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2) + '\n');
  };
  const lock = { name: 'todocue', version: '0.1.0', lockfileVersion: 3, packages: {
    '': { name: 'todocue', version: '0.1.0' },
    'node_modules/external': { version: '9.8.7', resolved: 'https://example.invalid/external.tgz', integrity: 'untouched' },
  } };
  write('package.json', lock.packages['']);
  for (const name of ['cli', 'engine', 'server', 'shared']) {
    const pkg = { name: `@todocue/${name}`, version: '0.1.0', dependencies: name === 'shared' ? {} : { '@todocue/shared': '0.1.0' } };
    write(`packages/${name}/package.json`, pkg);
    lock.packages[`packages/${name}`] = pkg;
  }
  write('package-lock.json', lock);
  write('packages/shared/src/index.ts', 'export const RUNTIME_VERSION = "0.1.0";\n');
  write('release-notes/v0.1.0.md', '# TodoCue v0.1.0\nFirst release.\n');
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'fixture');
  return { directory, write, read: file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) };
}

test('stable versions support bumps and reject malformed or older versions', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', '1.2.3'), '1.2.3');
  for (const value of ['01.2.3', 'v1.2.4', '1.2.4-beta.1', '1.1.9', '../x', '1.2.3\n', '1.2.9007199254740992']) {
    assert.throws(() => nextVersion('1.2.3', value));
  }
});

test('release checks reject tag mismatch, missing notes and each version drift', t => {
  const { directory, read, write } = fixture(t);
  assert.equal(checkRelease(directory, 'v0.1.0').notes, 'release-notes/v0.1.0.md');
  assert.throws(() => checkRelease(directory, 'v0.2.0'), /Tag/);
  const lock = read('package-lock.json');
  const badLock = structuredClone(lock);
  badLock.packages['packages/cli'].dependencies['@todocue/shared'] = '0.0.9';
  write('package-lock.json', badLock);
  assert.throws(() => checkRelease(directory), /package-lock/);
  write('package-lock.json', lock);
  const pkg = read('packages/engine/package.json');
  write('packages/engine/package.json', { ...pkg, version: '0.2.0' });
  assert.throws(() => checkRelease(directory), /packages\/engine/);
  write('packages/engine/package.json', pkg);
  write('packages/shared/src/index.ts', 'export const RUNTIME_VERSION = "0.0.1";');
  assert.throws(() => checkRelease(directory), /shared\/src/);
  write('packages/shared/src/index.ts', 'export const RUNTIME_VERSION = "0.1.0";');
  write('release-notes/v0.1.0.md', '  \n');
  assert.throws(() => checkRelease(directory), /Missing or empty/);
});

test('dry run leaves files, index, commits and tags untouched; missing notes fail before edits', t => {
  const { directory, write } = fixture(t);
  assert.throws(() => prepareRelease(directory, 'patch', true), /release-notes\/v0.1.1/);
  write('release-notes/v0.1.1.md', '# TodoCue v0.1.1\nSpacing update.\n');
  const status = git(directory, 'status', '--porcelain');
  const head = git(directory, 'rev-parse', 'HEAD');
  prepareRelease(directory, 'patch', true);
  assert.equal(checkRelease(directory).version, '0.1.0');
  assert.equal(git(directory, 'status', '--porcelain'), status);
  assert.equal(git(directory, 'rev-parse', 'HEAD'), head);
  assert.equal(git(directory, 'tag', '--list'), '');
});

test('release commit synchronizes packages, workspace lock and runtime before annotated tagging', t => {
  const { directory, write, read } = fixture(t);
  write('release-notes/v0.1.1.md', '# TodoCue v0.1.1\nSpacing update.\n');
  // Run the actual entry point with identity scoped to this child process, never git config.
  const scriptRoot = path.resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'const { prepareRelease } = await import(process.env.RELEASE_SCRIPT); prepareRelease(process.env.RELEASE_FIXTURE, "patch");'],
    { env: { ...gitEnv, RELEASE_SCRIPT: path.join(scriptRoot, 'release.mjs'), RELEASE_FIXTURE: directory }, stdio: 'pipe' });
  assert.equal(checkRelease(directory, 'v0.1.1').version, '0.1.1');
  assert.equal(read('package-lock.json').packages['node_modules/external'].integrity, 'untouched');
  assert.equal(git(directory, 'cat-file', '-t', 'v0.1.1'), 'tag');
  assert.equal(git(directory, 'rev-parse', 'v0.1.1^{}'), git(directory, 'rev-parse', 'HEAD'));
  assert.equal(git(directory, 'status', '--porcelain'), '');
  assert.throws(() => prepareRelease(directory, '0.1.1', true), /Tag already exists/);
});

test('unrelated staged work cannot enter a release commit or trigger version edits', t => {
  const { directory, write } = fixture(t);
  write('release-notes/v0.1.1.md', 'Release 0.1.1');
  write('unrelated.txt', 'Keep this work');
  git(directory, 'add', 'unrelated.txt');
  const status = git(directory, 'status', '--porcelain');
  assert.throws(() => prepareRelease(directory, 'patch'), /Commit or stash/);
  assert.equal(checkRelease(directory).version, '0.1.0');
  assert.equal(git(directory, 'status', '--porcelain'), status);
  assert.equal(git(directory, 'tag', '--list'), '');
});
