#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkVersions, checkRelease } from './release.mjs';
import { signingIdentity, notarize } from './macos-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/macos/build');
const version = checkVersions(root);
const arch = process.arch;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('Build on an arm64 or x64 Mac.');
const release = process.argv.includes('--release');
const profile = process.env.TODOCUE_NOTARY_PROFILE;
const keychain = process.env.TODOCUE_SIGN_KEYCHAIN;
if (release) {
  checkRelease(root, process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
  if (!profile) throw new Error('Release builds require TODOCUE_NOTARY_PROFILE; refusing an unnotarized release.');
}
const identity = signingIdentity(execFileSync('/usr/bin/security',
  ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])], { encoding: 'utf8' }), {
  override: process.env.TODOCUE_SIGN_IDENTITY, required: release, teamId: process.env.APPLE_TEAM_ID,
});
if (profile && identity === '-') throw new Error('Notarization requires a Developer ID Application signing identity.');
const notaryOptions = { profile, keychain, logDirectory: path.join(out, 'notarization') };
const nodeVersion = '26.7.0';
// Pinned official Node distribution checksums, not a Homebrew binary with external dylib dependencies.
const nodeHashes = {
  arm64: '7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4',
  x64: 'f279d1ed28ce57f7788bf23435d2ad7fdd7438904ad5c4d8a1081a7cde3d4b96',
};
function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}
function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

run('npm', ['run', 'build']);
run('/bin/bash', [path.join(root, 'scripts/build-macos.sh')]);
const app = path.join(out, 'TodoCue.app');
const resources = path.join(app, 'Contents/Resources');
const runtime = path.join(resources, 'runtime');
const cache = path.join(out, 'downloads');
fs.mkdirSync(cache, { recursive: true });
const archiveName = `node-v${nodeVersion}-darwin-${arch}`;
const archive = path.join(cache, `${archiveName}.tar.gz`);
if (!fs.existsSync(archive)) {
  console.log(`Downloading official Node ${nodeVersion} (${arch})…`);
  const partial = `${archive}.partial`;
  run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '180', '-o', partial,
    `https://nodejs.org/dist/v${nodeVersion}/${archiveName}.tar.gz`]);
  fs.renameSync(partial, archive);
}
const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (hash !== nodeHashes[arch]) throw new Error(`Node archive checksum mismatch: ${archive}`);
run('/usr/bin/tar', ['-xzf', archive, '-C', cache]);
const distribution = path.join(cache, archiveName);
copy(path.join(distribution, 'bin/node'), path.join(runtime, 'bin/node'));
copy(path.join(distribution, 'LICENSE'), path.join(runtime, 'NODE-LICENSE'));
for (const file of ['package.json', 'package-lock.json']) copy(path.join(root, file), path.join(runtime, file));
for (const name of ['shared', 'engine', 'server', 'cli']) {
  for (const file of ['package.json', 'dist']) copy(path.join(root, 'packages', name, file), path.join(runtime, 'packages', name, file));
}
console.log('Installing locked production dependencies inside the app…');
run(path.join(distribution, 'bin/node'), [path.join(distribution, 'lib/node_modules/npm/bin/npm-cli.js'),
  'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: runtime, env: { ...process.env, PATH: `${path.join(distribution, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` },
});
const prebuilds = path.join(runtime, 'node_modules/better-sqlite3/prebuilds');
for (const file of fs.readdirSync(prebuilds)) {
  if (file !== `darwin-${arch}.node`) fs.rmSync(path.join(prebuilds, file), { recursive: true, force: true });
}
copy(path.join(out, 'TodoCueNotifier.app'), path.join(app, 'Contents/Helpers/TodoCueNotifier.app'));
copy(path.join(root, 'skills/todocue'), path.join(resources, 'skills/todocue'));
const runtimeDigest = createHash('sha256');
for (const name of ['shared', 'engine', 'server', 'cli']) {
  const directory = path.join(runtime, 'packages', name, 'dist');
  for (const relative of fs.readdirSync(directory, { recursive: true }).sort()) {
    if (relative.endsWith('.js')) runtimeDigest.update(name + '/' + relative).update(fs.readFileSync(path.join(directory, relative)));
  }
}
runtimeDigest.update(fs.readFileSync(path.join(runtime, 'package-lock.json')));
fs.writeFileSync(path.join(runtime, 'BUILD.json'), JSON.stringify({ version, nodeVersion, arch, nodeSha256: hash, buildId: runtimeDigest.digest('hex') }, null, 2) + '\n');
// macOS normally uses a case-insensitive filesystem: never put `todocue` beside `TodoCue`.
fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
fs.writeFileSync(path.join(resources, 'bin/todocue'), `#!/bin/sh
runtime_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../runtime" && pwd)"
exec "$runtime_dir/bin/node" "$runtime_dir/packages/cli/dist/index.js" "$@"
`, { mode: 0o755 });
const appExecutable = path.join(app, 'Contents/MacOS/TodoCue');
if (!execFileSync('/usr/bin/file', [appExecutable], { encoding: 'utf8' }).includes('Mach-O')) {
  throw new Error('The main app executable must remain a native Mach-O binary.');
}

// Sign every executable inside-out; native addons share the Node executable's team identity.
const sign = (target, entitlements) => run('/usr/bin/codesign', [
  '--force', '--sign', identity, ...(identity === '-' ? [] : ['--timestamp']), '--options', 'runtime',
  ...(keychain ? ['--keychain', keychain] : []),
  ...(entitlements ? ['--entitlements', entitlements] : []), target,
]);
console.log(`Signing ${identity === '-' ? 'with an ad-hoc identity' : 'with Developer ID'}…`);
sign(path.join(prebuilds, `darwin-${arch}.node`));
sign(path.join(runtime, 'bin/node'), path.join(root, 'scripts/node.entitlements.plist'));
sign(path.join(app, 'Contents/Helpers/TodoCueNotifier.app'));
sign(app);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

console.log('Checking the bundled runtime without Homebrew or repository dependencies…');
run(path.join(runtime, 'bin/node'), ['--input-type=module', '-e', `
import Database from 'better-sqlite3';
import { buildMcpServer } from './packages/cli/dist/commands/mcp.js';
const db = new Database(':memory:');
if (db.prepare('select 42 as answer').get().answer !== 42) throw new Error('SQLite failed');
db.close();
const server = buildMcpServer(() => { throw new Error('not called by discovery'); });
await server.close();
console.log('Bundled Node, SQLite and MCP loaded successfully.');
`], { cwd: runtime, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } });

// Staple the app before placing it in the DMG so it retains its ticket after copying.
if (profile) {
  const archive = path.join(out, `TodoCue-${version}-${arch}-notarization.zip`);
  try {
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
    notarize(archive, notaryOptions);
    run('/usr/bin/xcrun', ['stapler', 'staple', app]);
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

const staging = fs.mkdtempSync(path.join(out, 'dmg-stage-'));
const dmg = path.join(out, `TodoCue-${version}-macOS-${arch}.dmg`);
try {
  run('/usr/bin/ditto', [app, path.join(staging, 'TodoCue.app')]);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  fs.writeFileSync(path.join(staging, '安装说明.txt'), `TodoCue ${version}\n\n将 TodoCue.app 拖入 Applications，然后从应用程序中打开。\n首次打开会自动配置后台服务与 CLI，不需要安装 Node。\n\n数据保存在 ~/.todocue/todocue.sqlite。\n删除或重新安装 App 不会删除此目录；请保留它以继续使用原有任务。\n\n若需要提醒，请在 App 设置中允许通知。\nAgent skill 随 App 附带，位于 Contents/Resources/skills/todocue。\n`);
  run('/usr/bin/hdiutil', ['create', '-volname', `TodoCue ${version}`, '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg]);
  if (identity !== '-') sign(dmg);
  if (profile) {
    notarize(dmg, notaryOptions);
    run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
    run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
  }
  if (identity !== '-') run('/usr/bin/codesign', ['--verify', '--strict', dmg]);
  // Hash the final stapled file, not the pre-notarization image.
  fs.writeFileSync(`${dmg}.sha256`, `${createHash('sha256').update(fs.readFileSync(dmg)).digest('hex')}  ${path.basename(dmg)}\n`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
console.log(`\nDMG ready: ${dmg}\nData stays in ~/.todocue across app replacements.`);
