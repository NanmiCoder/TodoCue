#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageFiles = ['package.json', ...['cli', 'engine', 'server', 'shared'].map(name => `packages/${name}/package.json`)];
const runtimeFile = 'packages/shared/src/index.ts';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const runtimeVersion = /export const RUNTIME_VERSION = "([^"]+)";/;
const json = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();

export function validateVersion(version) {
  if (typeof version !== 'string' || version.trim() !== version || !stableVersion.test(version) || version.split('.').some(n => !Number.isSafeInteger(Number(n)))) {
    throw new Error(`Expected a stable x.y.z version, received: ${version}`);
  }
  return version;
}

export function nextVersion(current, bump) {
  validateVersion(current);
  const parts = current.split('.').map(Number);
  const position = ['major', 'minor', 'patch'].indexOf(bump);
  if (position >= 0) {
    parts[position] += 1;
    for (let i = position + 1; i < parts.length; i++) parts[i] = 0;
    return validateVersion(parts.join('.'));
  }
  validateVersion(bump);
  const next = bump.split('.').map(Number);
  const difference = next.map((n, i) => n - parts[i]).find(n => n !== 0) ?? 0;
  if (difference < 0) throw new Error(`Cannot release an older version: ${current} → ${bump}`);
  return bump;
}

export function checkVersions(directory = root) {
  const version = validateVersion(json(directory, 'package.json').version);
  const lock = json(directory, 'package-lock.json');
  const assertVersion = (actual, label) => {
    if (actual !== version) throw new Error(`${label}: expected ${version}, found ${actual}`);
  };
  assertVersion(lock.version, 'package-lock.json');
  for (const file of packageFiles) {
    const pkg = json(directory, file);
    const key = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    assertVersion(pkg.version, file);
    assertVersion(lock.packages[key]?.version, `package-lock.json packages[${key}]`);
    for (const [name, value] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith('@todocue/')) {
        assertVersion(value, `${file} ${name}`);
        assertVersion(lock.packages[key]?.dependencies?.[name], `package-lock.json ${key} ${name}`);
      }
    }
  }
  assertVersion(fs.readFileSync(path.join(directory, runtimeFile), 'utf8').match(runtimeVersion)?.[1], runtimeFile);
  return version;
}

export function releaseNotes(directory, version) {
  const file = `release-notes/v${validateVersion(version)}.md`;
  if (!fs.existsSync(path.join(directory, file)) || !fs.readFileSync(path.join(directory, file), 'utf8').trim()) {
    throw new Error(`Missing or empty release notes: ${file}`);
  }
  return file;
}

export function checkRelease(directory = root, tag) {
  const version = checkVersions(directory);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match v${version}`);
  return { version, tag: `v${version}`, notes: releaseNotes(directory, version) };
}

export function prepareRelease(directory, bump, dry = false) {
  const current = checkVersions(directory);
  const version = nextVersion(current, bump);
  const notes = releaseNotes(directory, version);
  const tag = `v${version}`;
  const files = [...packageFiles, 'package-lock.json', runtimeFile, notes];
  if (git(directory, ['tag', '--list', tag])) throw new Error(`Tag already exists: ${tag}`);
  const branch = git(directory, ['branch', '--show-current']);
  if (!branch) throw new Error('Release preparation requires a branch, not detached HEAD.');
  console.log(`${current} → ${version}\nTag: ${tag}\nNotes: ${notes}\nFiles: ${files.join(', ')}`);
  if (dry) {
    console.log('Dry run: no files, commits or tags changed.');
    return { version, tag, notes, files };
  }
  // Allow the new notes, but never include another staged change in the release commit.
  const dirty = git(directory, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${notes}`]);
  if (dirty) throw new Error('Commit or stash existing changes before preparing a release. Only the target release notes may be uncommitted.');
  const lock = json(directory, 'package-lock.json');
  lock.version = version;
  for (const file of packageFiles) {
    const pkg = json(directory, file);
    pkg.version = version;
    const key = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    lock.packages[key].version = version;
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith('@todocue/')) {
        pkg.dependencies[name] = version;
        lock.packages[key].dependencies[name] = version;
      }
    }
    fs.writeFileSync(path.join(directory, file), JSON.stringify(pkg, null, 2) + '\n');
  }
  // Only workspace versions change; retain all external resolutions and integrity hashes.
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const runtimePath = path.join(directory, runtimeFile);
  fs.writeFileSync(runtimePath, fs.readFileSync(runtimePath, 'utf8').replace(runtimeVersion, `export const RUNTIME_VERSION = "${version}";`));
  checkRelease(directory, tag);
  git(directory, ['add', '--', ...files]);
  if (git(directory, ['diff', '--cached', '--name-only'])) git(directory, ['commit', '-m', `release: ${tag}`]);
  git(directory, ['tag', '-a', tag, '-m', `TodoCue ${tag}`]);
  console.log(`Ready. Push only this branch and tag:\n  git push origin ${branch} ${tag}`);
  return { version, tag, notes, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--check' && args.length <= 2) console.log(JSON.stringify(checkRelease(root, args[1])));
    else if (args[0] && args.length <= 2 && (args.length === 1 || args[1] === '--dry')) prepareRelease(root, args[0], args[1] === '--dry');
    else throw new Error('Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry], or --check [vX.Y.Z]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
