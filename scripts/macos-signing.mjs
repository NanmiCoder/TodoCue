import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Retry only the observed Apple CloudKit connection loss; validation remains mandatory. */
export async function validateStapled(target, { run = execFileSync, sleep = delay, attempts = 3, log = value => process.stdout.write(value) } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Expected 1–3 ticket validation attempts');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const output = run('/usr/bin/xcrun', ['stapler', 'validate', target], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (output) log(output.toString());
      return;
    } catch (error) {
      const output = (error.stdout?.toString() ?? '') + (error.stderr?.toString() ?? '');
      if (output) log(output);
      const transient = !error.signal && error.status === 68 && /NSURLErrorDomain[^\n]*Code=-1005\b/.test(output);
      if (!transient || attempt === attempts) throw error;
      log(`Apple ticket connection lost; retrying validation (${attempt + 1}/${attempts})\n`);
      await sleep(attempt * 5000);
    }
  }
}

export function signingIdentity(output, { override, required = false, teamId } = {}) {
  const identities = [...output.matchAll(/\d+\)\s+([A-F0-9]{40}) "([^"]+)"/gi)]
    .map(([, hash, name]) => ({ hash, name }));
  const selected = override
    ? identities.find(({ hash, name }) => hash.toUpperCase() === override.toUpperCase() || name === override)
    : identities.find(({ name }) => name.startsWith('Developer ID Application:'));
  if (override === '-' && !required) return '-';
  if (!selected) {
    if (required || override) throw new Error('No matching Developer ID Application signing identity with private key.');
    return '-';
  }
  if (required && (!selected.name.startsWith('Developer ID Application:') || !teamId || !selected.name.endsWith(`(${teamId})`))) {
    throw new Error('Release signing requires a Developer ID Application certificate matching APPLE_TEAM_ID.');
  }
  return selected.hash;
}

/** An exit code alone is insufficient: publish only an explicit Accepted submission. */
export function notarize(archive, { profile, keychain, logDirectory, run = execFileSync }) {
  const credentials = ['--keychain-profile', profile, ...(keychain ? ['--keychain', keychain] : [])];
  const options = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  let stdout;
  let failure;
  try {
    stdout = run('/usr/bin/xcrun', ['notarytool', 'submit', archive, ...credentials,
      '--wait', '--timeout', '30m', '--output-format', 'json'], options);
  } catch (error) {
    stdout = error.stdout?.toString() ?? '';
    failure = error;
  }
  fs.mkdirSync(logDirectory, { recursive: true });
  const prefix = path.join(logDirectory, path.basename(archive));
  fs.writeFileSync(`${prefix}.submission.json`, stdout || '{}');
  let result;
  try { result = JSON.parse(stdout); } catch { /* Transport failures may have no JSON response. */ }
  if (!failure && result?.status === 'Accepted') return result;
  if (/^[0-9a-f-]{36}$/i.test(result?.id ?? '')) {
    try { run('/usr/bin/xcrun', ['notarytool', 'log', result.id, ...credentials, `${prefix}.notary-log.json`], options); }
    catch { /* Keep the original submission failure, even if fetching its log fails. */ }
  }
  throw new Error(`Notarization did not succeed (${result?.status ?? 'submission/timeout error'}). See ${prefix}.submission.json and the Apple submission log.`);
}
