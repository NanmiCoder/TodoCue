#!/usr/bin/env node
// Opt-in macOS documentation capture; creates new databases and never reuses user data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startRuntime } from '../packages/server/dist/index.js';
import { MemoryNotifier } from '../packages/engine/dist/index.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'todocue-readme-'));
const photoPath = process.argv[2];
if (!photoPath) throw new Error('Usage: node scripts/readme-screenshots.mjs /absolute/path/hike-photo.png');
const photo = await fs.readFile(photoPath);
const trail = await fs.readFile(path.join(root, "assets/readme/demo/forest-trail.png"));
const runtimes = [];
const fixtures = [];
const texts = {
  en: { project: 'Product launch', title: 'Plan the weekend hike', notes: 'Compare the lakeside trail and check the weather. Pack light and leave early.', quick: 'Send the launch summary to the team', draft: 'Prepare the next product update', draftNotes: 'Collect feedback from this week and outline the changes worth sharing.', tasks: ['Review the launch checklist', 'Polish the onboarding copy', 'Reply to design feedback', 'Book a table for Friday', 'Share the release notes', 'Clear the inbox'] },
  'zh-Hans': { project: '产品发布', title: '确认周末徒步路线', notes: '看看湖边步道，出发前确认天气。轻装出发，给自己留一个慢下来的周末。', quick: '把这次发布的总结发给团队', draft: '准备下一期产品更新', draftNotes: '整理本周收到的反馈，挑出值得和大家分享的变化。', tasks: ['检查产品发布清单', '润色新用户引导文案', '回复设计评审的反馈', '预订周五晚餐', '整理本次更新说明', '清理邮件收件箱'] },
};
try {
  for (const [language, t] of Object.entries(texts)) {
    const runtime = await startRuntime({ home: path.join(home, language), port: 0, notifier: new MemoryNotifier(), logger: { info() {}, warn() {}, error() {}, debug() {} } });
    runtimes.push(runtime);
    const engine = runtime.engine, today = engine.context().today;
    const tomorrow = new Date(today + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const next = tomorrow.toISOString().slice(0, 10);
    engine.createTask({ title: t.tasks[0], project: t.project, scheduledDate: today, dueDate: today, priority: 'high', estimateMinutes: 20 });
    engine.createTask({ title: t.tasks[1], project: t.project, scheduledDate: today, estimateMinutes: 25 });
    engine.createTask({ title: t.tasks[2], project: t.project, scheduledDate: today, estimateMinutes: 15 });
    const detail = engine.createTask({ title: t.title, notes: t.notes, project: language === 'en' ? 'Life' : '生活', scheduledDate: today, estimateMinutes: 30,
      attachments: [{ name: language === 'en' ? 'Lakeside route.png' : '湖边步道.png', mediaType: 'image/png', dataBase64: photo.toString('base64') }, { name: language === 'en' ? 'Forest trail.png' : '林间小径.png', mediaType: 'image/png', dataBase64: trail.toString('base64') }] }).task;
    engine.createTask({ title: t.tasks[3], scheduledDate: next });
    for (const title of t.tasks.slice(4)) { const task = engine.createTask({ title, scheduledDate: today }).task; engine.completeTask(task.id, { expectedVersion: task.version }); }
    fixtures.push({ language, connection: JSON.parse(await fs.readFile(path.join(home, language, 'connection.json'), 'utf8')), detailTaskId: detail.id, quickTitle: t.draft, draftTitle: t.draft, draftNotes: t.draftNotes, project: t.project });
  }
  const manifest = path.join(home, 'fixtures.json');
  await fs.writeFile(manifest, JSON.stringify(fixtures));
  const child = spawn('swift', ['test', '--package-path', 'apps/macos', '--filter', 'ReadmeScreenshotTests/testCaptureReadmePanels'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, TODOCUE_HOME: home, TODOCUE_README_FIXTURES: manifest, TODOCUE_README_OUTPUT: path.join(root, 'assets/readme') },
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`Screenshot capture failed (${code}); fixture home: ${home}`);
  console.log('Captured 8 native window PNGs at 2× resolution, without cursor or other windows.');
} finally { for (const runtime of runtimes) await runtime.stop(); }
