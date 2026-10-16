import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signingIdentity, notarize, validateStapled } from '../macos-signing.mjs';

const developerHash = 'A'.repeat(40);
const developmentHash = 'B'.repeat(40);
const identities = `1) ${developmentHash} "Apple Development: Person (TEAM123456)"\n2) ${developerHash} "Developer ID Application: Company (TEAM123456)"`;

test('stapled ticket validation recovers a CloudKit disconnect and still validates again', async () => {
  let calls = 0;
  const pauses = [];
  await validateStapled('/tmp/TodoCue.app', { log: () => {}, sleep: async ms => { pauses.push(ms); }, run: (_command, args) => {
    assert.deepEqual(args, ['stapler', 'validate', '/tmp/TodoCue.app']);
    if (++calls === 1) throw Object.assign(new Error('network lost'), { status: 68, stderr: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' });
    return 'The validate action worked!';
  } });
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [5000]);
});

for (const scenario of ['permanent', 'repeated-network', 'signal']) {
  test(`ticket validation fails closed for ${scenario}`, async () => {
    let calls = 0;
    const failure = Object.assign(new Error(scenario), { status: scenario === 'signal' ? null : 68,
      signal: scenario === 'signal' ? 'SIGKILL' : null,
      stdout: scenario === 'permanent' ? 'Invalid ticket. The validate action failed! Error 68.' : 'Error Domain=NSURLErrorDomain Code=-1005' });
    await assert.rejects(validateStapled('/tmp/TodoCue.dmg', { run: () => { calls++; throw failure; }, sleep: async () => {}, log: () => {} }), error => error === failure);
    assert.equal(calls, scenario === 'repeated-network' ? 3 : 1);
  });
}

test('invalid retry limits never bypass ticket validation', async () => {
  for (const attempts of [0, -1, NaN, 4]) {
    await assert.rejects(validateStapled('/tmp/TodoCue.app', { attempts }), /1–3/);
  }
});

test('release signing fails closed on missing, development, ad-hoc or wrong-team identities', () => {
  assert.equal(signingIdentity(identities, { required: true, teamId: 'TEAM123456' }), developerHash);
  assert.equal(signingIdentity(''), '-');
  assert.equal(signingIdentity(identities, { override: '-' }), '-');
  assert.throws(() => signingIdentity('', { required: true, teamId: 'TEAM123456' }), /No matching/);
  assert.throws(() => signingIdentity(identities, { required: true, teamId: 'DIFFERENT' }), /matching APPLE_TEAM_ID/);
  assert.throws(() => signingIdentity(identities, { required: true, teamId: 'TEAM123456', override: developmentHash }), /Developer ID/);
  assert.throws(() => signingIdentity(identities, { required: true, teamId: 'TEAM123456', override: '-' }), /No matching/);
});

for (const status of ['Accepted', 'Invalid', 'In Progress', 'malformed', 'timeout', 'transport']) {
  test(`notarization handles ${status} without accidentally publishing`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todocue-notary-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const calls = [];
    const id = '12345678-1234-1234-1234-123456789abc';
    const run = (command, args) => {
      calls.push({ command, args });
      if (args[1] === 'log') return '';
      if (status === 'transport') throw Object.assign(new Error('network error'), { stdout: '' });
      if (status === 'timeout') throw Object.assign(new Error('timeout'), { stdout: JSON.stringify({ id, status: 'In Progress' }) });
      if (status === 'malformed') return 'not valid JSON';
      return JSON.stringify({ id, status });
    };
    const invoke = () => notarize('/tmp/TodoCue.dmg', { profile: 'profile', keychain: '/tmp/test.keychain-db', logDirectory: directory, run });
    if (status === 'Accepted') assert.equal(invoke().status, 'Accepted');
    else assert.throws(invoke, /Notarization did not succeed/);
    assert.ok(fs.existsSync(path.join(directory, 'TodoCue.dmg.submission.json')));
    assert.ok(calls[0].args.includes('--keychain'));
    assert.ok(calls[0].args.includes('--wait'));
    assert.equal(calls.some(call => call.args[1] === 'log'), ['Invalid', 'In Progress', 'timeout'].includes(status));
  });
}
