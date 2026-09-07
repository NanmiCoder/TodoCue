import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

for (const scenario of ['new', 'draft', 'public', 'api-error', 'upload-error']) {
  test(`publishing ${scenario}: a release becomes public only after successful upload`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todocue-publish-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'release-notes'));
    fs.writeFileSync(path.join(directory, 'release-notes/v0.1.0.md'), '# TodoCue v0.1.0\n');
    fs.mkdirSync(path.join(directory, 'bin'));
    const mock = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (process.env.SCENARIO === 'public') console.log('false');
  else if (process.env.SCENARIO === 'draft') console.log('true');
  else { console.error(process.env.SCENARIO === 'api-error' ? 'HTTP 403' : 'HTTP 404'); process.exit(1); }
}
if (args[1] === 'upload' && process.env.SCENARIO === 'upload-error') process.exit(1);
`;
    fs.writeFileSync(path.join(directory, 'bin/gh'), mock, { mode: 0o755 });
    const result = spawnSync('bash', [path.resolve(import.meta.dirname, '../ci-publish-release.sh')], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'example/todocue', RELEASE_VERSION: '0.1.0', GITHUB_REF_NAME: 'v0.1.0',
        CALLS: path.join(directory, 'calls.jsonl'), SCENARIO: scenario },
    });
    const calls = fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const published = calls.some(args => args[1] === 'edit' && args.includes('--draft=false'));
    assert.equal(published, ['new', 'draft'].includes(scenario), result.stderr);
    assert.equal(result.status === 0, published, result.stderr);
    if (published) {
      assert.ok(calls.findIndex(args => args[1] === 'upload') < calls.findIndex(args => args[1] === 'edit'));
      if (scenario === 'new') assert.ok(calls.find(args => args[1] === 'create').includes('--draft'));
    }
    if (['public', 'api-error'].includes(scenario)) assert.equal(calls.length, 1);
  });
}
