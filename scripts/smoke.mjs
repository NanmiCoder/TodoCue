#!/usr/bin/env node
// Real local HTTP + CLI + MCP processes against a disposable persistent database.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { startRuntime, TodoCueClient } from '../packages/server/dist/index.js';
import { MemoryNotifier } from '../packages/engine/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'todocue-smoke-'));
const cliEntry = path.join(root, 'packages/cli/dist/index.js');
const env = { ...process.env, TODOCUE_HOME: home, TODOCUE_TZ: 'Asia/Shanghai' };
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const run = promisify(execFile);
let rt;
let mcp;
const abort = new AbortController();
let stream;
async function cli(...args) {
  const result = await run(process.execPath, [cliEntry, '--json', ...args], { env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out waiting for runtime event');
}
try {
  const notifier = new MemoryNotifier();
  rt = await startRuntime({ home, port: 0, notifier, logger: silent });
  let client = new TodoCueClient({ baseUrl: rt.baseUrl, token: rt.token });
  const events = [];
  stream = client.events((event) => events.push(event), { signal: abort.signal }).catch(() => {});
  await until(() => events.some((event) => event.type === 'runtime.started'));

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
  const first = path.join(home, '图片 one.png'), second = path.join(home, 'notes.txt');
  await fs.writeFile(first, png); await fs.writeFile(second, '图文资料\n');
  const created = await cli('add', 'CLI 图文冒烟', '--date', 'today', '--attach', first, '--attach', second);
  assert.equal(created.task.attachments.length, 2);
  await fs.unlink(first);
  const saved = path.join(home, 'download.png');
  await cli('attachments', 'save', created.task.id, created.task.attachments[0].id, saved);
  assert.deepEqual(await fs.readFile(saved), png);
  await assert.rejects(cli('attachments', 'save', created.task.id, created.task.attachments[0].id, saved));
  assert.deepEqual(await fs.readFile(saved), png, 'download must not overwrite existing files');
  console.log('PASS CLI create with multiple attachments, download and overwrite protection');

  mcp = spawn(process.execPath, [cliEntry, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let id = 0;
  const lines = createInterface({ input: mcp.stdout });
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    if (response.id == null) return;
    const waiter = waiting.get(response.id);
    if (!waiter) return;
    waiting.delete(response.id); clearTimeout(waiter.timer);
    response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { waiting.delete(current); reject(new Error(`MCP timed out: ${method}`)); }, 10_000);
    waiting.set(current, { resolve, reject, timer });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'todocue-smoke', version: '1.0.0' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc('tools/list', {})).tools.map((tool) => tool.name);
  for (const name of ['add', 'list', 'get', 'remove']) assert(tools.includes(`todocue_${name}_attachment${['add', 'list'].includes(name) ? 's' : ''}`));
  const call = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert(!result.isError, result.content?.[0]?.text);
    return result;
  };
  const resultData = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
  const mcpCreated = resultData(await call('todocue_create_task', { title: 'MCP 图文冒烟', attachments: [{ name: 'pixel.png', mediaType: 'image/png', dataBase64: png.toString('base64') }] }));
  const mcpId = mcpCreated.task.id;
  const added = resultData(await call('todocue_add_attachments', { id: mcpId, paths: [saved, second], idempotencyKey: 'smoke-files' }));
  assert.equal(added.task.attachments.length, 3);
  const replay = resultData(await call('todocue_add_attachments', { id: mcpId, paths: [saved, second], idempotencyKey: 'smoke-files' }));
  assert.deepEqual(replay, added);
  const read = await call('todocue_get_attachment', { id: mcpId, attachmentId: added.task.attachments[0].id });
  assert.equal(read.content[1].type, 'image'); assert.equal(read.content[1].data, png.toString('base64'));
  await call('todocue_remove_attachment', { id: mcpId, attachmentId: added.task.attachments[1].id, expectedVersion: 2 });
  assert.equal(resultData(await call('todocue_list_attachments', { id: mcpId })).attachments.length, 2);
  console.log('PASS MCP initialize, discover, create, multi-file upload, retry, image read and remove');

  await client.updateTask(created.task.id, { reminderAt: new Date(Date.now() - 1000).toISOString() });
  await rt.scheduler.tick();
  await until(() => events.some((event) => event.type === 'reminder.fired' && event.related?.taskId === created.task.id));
  assert(notifier.delivered.some((item) => item.taskId === created.task.id));
  assert.equal(events.filter((event) => event.type === 'reminder.fired' && event.related?.taskId === created.task.id).length, 1);
  console.log('PASS scheduler → system notification sink + SSE Cue event');

  abort.abort(); await stream; mcp.stdin.end(); mcp.kill(); mcp = undefined;
  const exported = await client.export();
  assert.equal(exported.attachments.length, 4);
  await rt.stop(); rt = undefined;
  rt = await startRuntime({ home, port: 0, notifier, logger: silent });
  client = new TodoCueClient({ baseUrl: rt.baseUrl, token: rt.token });
  assert.equal((await cli('show', mcpId)).task.attachments.length, 2);
  assert.equal((await client.getAttachment(created.task.id, created.task.attachments[0].id)).dataBase64, png.toString('base64'));
  assert.deepEqual((await client.export()).attachments, exported.attachments);
  console.log('PASS persistent runtime restart, original-file removal and full export round-trip');
} finally {
  abort.abort(); if (stream) await stream;
  mcp?.stdin.end(); mcp?.kill();
  if (rt) await rt.stop();
  await fs.rm(home, { recursive: true, force: true });
}
