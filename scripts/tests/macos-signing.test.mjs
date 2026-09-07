import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signingIdentity, notarize } from '../macos-signing.mjs';

const developerHash = 'A'.repeat(40);
const developmentHash = 'B'.repeat(40);
const identities = `1) ${developmentHash} "Apple Development: Person (TEAM123456)"\n2) ${developerHash} "Developer ID Application: Company (TEAM123456)"`;

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
