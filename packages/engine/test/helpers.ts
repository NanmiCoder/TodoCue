import { FakeClock, MemoryNotifier, Scheduler, TaskEngine, openDatabase } from "../src/index.js";

export function makeEngine(opts: { now?: string; tz?: string; horizonDays?: number } = {}) {
  const clock = new FakeClock(opts.now ?? "2026-09-07T01:00:00.000Z"); // 09:00 Asia/Shanghai
  const { db } = openDatabase({ path: ":memory:" });
  const engine = new TaskEngine({ db, clock, timezone: opts.tz ?? "Asia/Shanghai", horizonDays: opts.horizonDays });
  const notifier = new MemoryNotifier();
  const scheduler = new Scheduler({ engine, notifier, tickMs: 1000 });
  return { clock, db, engine, notifier, scheduler };
}
