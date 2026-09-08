#!/usr/bin/env node
// Local calendar verification: isolated runtime + offscreen SwiftUI render. Never touches ~/.todocue.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startRuntime } from '../packages/server/dist/index.js';
import { MemoryNotifier } from '../packages/engine/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'todocue-calendar-'));
const runtimes = [];
const fixtures = [];
const texts = {
  en: { p: 'Product', daily: 'Daily standup', weekly: 'Gym session', today: 'Review the launch checklist',
        far: 'Renew the domain', done: 'Ship the release notes', split: 'Draft the quarterly report',
        overdue: 'Reply to the design feedback' },
  'zh-Hans': { p: '产品', daily: '每日站会', weekly: '去健身房', today: '检查产品发布清单',
        far: '续费域名', done: '整理本次更新说明', split: '写季度报告', overdue: '回复设计评审的反馈' },
};

const shift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

try {
  for (const [language, t] of Object.entries(texts)) {
    const runtime = await startRuntime({ home: path.join(home, language), port: 0, notifier: new MemoryNotifier(),
      logger: { info() {}, warn() {}, error() {}, debug() {} } });
    runtimes.push(runtime);
    const engine = runtime.engine, today = engine.context().today;

    engine.createTask({ title: t.today, project: t.p, scheduledDate: today, priority: 'high', estimateMinutes: 20 });
    engine.createTask({ title: t.overdue, project: t.p, scheduledDate: shift(today, -2), dueDate: shift(today, -2) });
    // Two months out, well past the 30-day generation horizon.
    engine.createTask({ title: t.far, scheduledDate: shift(today, 62) });
    // Planned one day, due another: two marks, on two different days.
    engine.createTask({ title: t.split, project: t.p, scheduledDate: shift(today, 1), dueDate: shift(today, 5) });
    // History behind today.
    const old = engine.createTask({ title: t.done, scheduledDate: shift(today, -6) }).task;
    engine.completeTask(old.id, { expectedVersion: old.version });
    // Recurring: real rows for 30 days, projected ghosts beyond.
    engine.createTask({ title: t.daily, repeat: { kind: 'daily' }, scheduledTime: '09:00', startDate: today });
    engine.createTask({ title: t.weekly, repeat: { kind: 'weekly', weekdays: [1, 3, 5] }, scheduledTime: '19:00', startDate: today });

    fixtures.push({ language, today, connection: JSON.parse(await fs.readFile(path.join(home, language, 'connection.json'), 'utf8')) });
  }
  const manifest = path.join(home, 'fixtures.json');
  await fs.writeFile(manifest, JSON.stringify(fixtures));
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '.ui-review/calendar/shots');
  // Clear only the renders. The directory also holds a hand-written README describing them.
  await fs.mkdir(out, { recursive: true });
  for (const name of await fs.readdir(out)) {
    if (name.endsWith('.png')) await fs.rm(path.join(out, name));
  }
  const child = spawn('swift', ['test', '--package-path', 'apps/macos', '--filter', 'CalendarSnapshotTests'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, TODOCUE_HOME: home, TODOCUE_CALENDAR_FIXTURES: manifest, TODOCUE_CALENDAR_OUTPUT: out } });
  const code = await new Promise((res, rej) => { child.on('error', rej); child.on('exit', res); });
  if (code !== 0) throw new Error(`capture failed (${code}); fixture home: ${home}`);
  console.log('shots ->', out);
} finally { for (const r of runtimes) await r.stop(); }
