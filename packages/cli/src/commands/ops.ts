import type { Command } from "commander";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_VERSION, TodoCueError, ErrorCodes, type DoctorCheck } from "@todocue/shared";
import { HelperNotifier, TaskEngine, defaultHelperCandidates, openDatabase } from "@todocue/engine";
import {
  TodoCueClient,
  ensureHome,
  isRuntimeAlive,
  resolveHome,
  runtimePaths,
  startRuntime,
  type RuntimePaths,
} from "@todocue/server";
import { print, type OutputOptions } from "../output.js";
import {
  installLaunchAgent,
  launchAgentStatus,
  restartLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "../launchagent.js";

const execFileP = promisify(execFile);
type Ctx = { client: () => TodoCueClient; out: () => OutputOptions; home: () => string | undefined };

function cliEntryPath(): string {
  // packages/cli/dist/commands/ops.js -> packages/cli/dist/index.js
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function builtApp(name: string): string | null {
  const p = path.join(repoRoot(), "apps", "macos", "build", `${name}.app`);
  return fs.existsSync(p) ? p : null;
}

async function copyBundle(src: string, dest: string): Promise<void> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // ditto preserves bundle metadata and code signatures.
  await execFileP("/usr/bin/ditto", [src, dest]);
}

/** Write ~/.todocue/bin/todocue (a tiny wrapper) and link it into a PATH dir when possible. */
function installCliWrapper(paths: RuntimePaths): string {
  const wrapper = path.join(paths.bin, "todocue");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cliEntryPath()}" "$@"\n`, { mode: 0o755 });
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      const link = path.join(dir, "todocue");
      try {
        const existing = fs.readlinkSync(link);
        if (existing === wrapper) return `${wrapper} (linked from ${link})`;
        fs.unlinkSync(link);
      } catch {
        /* not a symlink or missing */
      }
      if (!fs.existsSync(link)) {
        fs.symlinkSync(wrapper, link);
        return `${wrapper} (linked from ${link})`;
      }
    } catch {
      /* not writable */
    }
  }
  return `${wrapper} (add ${paths.bin} to PATH)`;
}

async function waitForRuntime(paths: RuntimePaths, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isRuntimeAlive(paths)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export function registerOpsCommands(program: Command, ctx: Ctx): void {
  program
    .command("serve")
    .description("run the runtime in the foreground (used by the LaunchAgent)")
    .option("--port <n>")
    .action(async (opts) => {
      const rt = await startRuntime({ home: ctx.home(), port: opts.port ? Number.parseInt(opts.port, 10) : undefined });
      const shutdown = async (sig: string) => {
        process.stdout.write(`received ${sig}, stopping\n`);
        await rt.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      // Keep the process alive.
      await new Promise(() => {});
    });

  const service = program.command("service").description("manage the background runtime (launchd user agent)");
  service
    .command("install")
    .description("install and start the LaunchAgent")
    .option("--port <n>")
    .action(async (opts) => {
      const paths = runtimePaths(resolveHome(ctx.home()));
      ensureHome(paths);
      const plist = await installLaunchAgent(paths, {
        nodePath: process.execPath,
        cliEntry: cliEntryPath(),
        port: opts.port ? Number.parseInt(opts.port, 10) : undefined,
      });
      const up = await waitForRuntime(paths, 10_000);
      print(ctx.out(), { plist, running: up }, () => `installed ${plist}\nruntime ${up ? "is running" : "did not report healthy within 10s; check " + paths.logs}`);
    });
  service.command("uninstall").description("stop and remove the LaunchAgent (task data is kept)").action(async () => {
    const paths = runtimePaths(resolveHome(ctx.home()));
    const removed = await uninstallLaunchAgent(paths);
    print(ctx.out(), { removed }, () => (removed ? `removed ${paths.launchAgentPlist}; data kept in ${paths.home}` : "service was not installed"));
  });
  service.command("start").action(async () => {
    const paths = runtimePaths(resolveHome(ctx.home()));
    const out = await startLaunchAgent(paths);
    const up = await waitForRuntime(paths, 10_000);
    print(ctx.out(), { running: up, out }, () => (up ? "runtime is running" : `runtime not healthy yet${out ? `: ${out}` : ""}`));
  });
  service.command("stop").action(async () => {
    const paths = runtimePaths(resolveHome(ctx.home()));
    const out = await stopLaunchAgent(paths);
    await new Promise((r) => setTimeout(r, 500));
    const alive = await isRuntimeAlive(paths);
    print(ctx.out(), { running: !!alive, out }, () => (alive ? `runtime still reachable (pid ${alive.pid}); it may have been started manually` : "runtime stopped"));
  });
  service.command("restart").action(async () => {
    const paths = runtimePaths(resolveHome(ctx.home()));
    await restartLaunchAgent(paths);
    const up = await waitForRuntime(paths, 10_000);
    print(ctx.out(), { running: up }, () => (up ? "runtime restarted" : "runtime not healthy after restart"));
  });
  service.command("status").action(async () => {
    const paths = runtimePaths(resolveHome(ctx.home()));
    const la = await launchAgentStatus(paths);
    const alive = await isRuntimeAlive(paths);
    print(ctx.out(), { launchAgent: la, runtime: alive }, () =>
      [
        `launch agent: ${la.detail}`,
        alive ? `runtime: reachable at ${alive.baseUrl} (pid ${alive.pid}, v${alive.runtimeVersion})` : "runtime: not reachable",
      ].join("\n"),
    );
  });

  program
    .command("install")
    .description("install everything for this Mac: home dir, notifier helper, app, LaunchAgent, notification permission")
    .option("--skip-apps", "do not copy the macOS app bundles")
    .option("--skip-notifications", "do not request notification authorization")
    .option("--port <n>")
    .action(async (opts) => {
      const paths = runtimePaths(resolveHome(ctx.home()));
      ensureHome(paths);
      const steps: { step: string; ok: boolean; detail: string }[] = [];
      const helperSrc = builtApp("TodoCueNotifier");
      const appSrc = builtApp("TodoCue");
      if (!opts.skipApps) {
        if (helperSrc) {
          await copyBundle(helperSrc, path.join(paths.bin, "TodoCueNotifier.app"));
          steps.push({ step: "notifier", ok: true, detail: `installed to ${path.join(paths.bin, "TodoCueNotifier.app")}` });
        } else {
          steps.push({ step: "notifier", ok: false, detail: "apps/macos/build/TodoCueNotifier.app not found; run `npm run macos:build` then `todocue install` again" });
        }
        if (appSrc) {
          const dest = path.join(os.homedir(), "Applications", "TodoCue.app");
          await copyBundle(appSrc, dest);
          steps.push({ step: "app", ok: true, detail: `installed to ${dest}` });
        } else {
          steps.push({ step: "app", ok: false, detail: "apps/macos/build/TodoCue.app not found; run `npm run macos:build`" });
        }
      }
      const wrapper = installCliWrapper(paths);
      steps.push({ step: "cli", ok: true, detail: wrapper });
      const plist = await installLaunchAgent(paths, {
        nodePath: process.execPath,
        cliEntry: cliEntryPath(),
        port: opts.port ? Number.parseInt(opts.port, 10) : undefined,
      });
      const up = await waitForRuntime(paths, 15_000);
      steps.push({ step: "service", ok: up, detail: up ? `LaunchAgent ${plist} running` : `LaunchAgent installed but runtime not healthy; see ${paths.logs}` });
      if (up && !opts.skipNotifications) {
        const client = TodoCueClient.fromHome(paths.home)!;
        try {
          const auth = await client.requestNotificationAuthorization();
          steps.push({ step: "notifications", ok: auth.authorization === "authorized" || auth.authorization === "provisional", detail: `authorization: ${auth.authorization}${auth.detail ? ` (${auth.detail})` : ""}` });
        } catch (e) {
          steps.push({ step: "notifications", ok: false, detail: (e as Error).message });
        }
      }
      print(ctx.out(), { steps }, () =>
        steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.step.padEnd(14)} ${s.detail}`).join("\n") +
        `\n\nnext: open ~/Applications/TodoCue.app (menu bar + notch panel); agents: \`todocue mcp\`; check: \`todocue doctor\``,
      );
    });

  program
    .command("doctor")
    .description("diagnose installation, runtime, notifications and reminders")
    .option("--request-notifications", "trigger the system notification permission prompt")
    .action(async (opts) => {
      const home = resolveHome(ctx.home());
      const paths = runtimePaths(home);
      const checks: DoctorCheck[] = [];
      const add = (name: string, ok: boolean, detail: string, level: DoctorCheck["level"] = ok ? "ok" : "warn") => checks.push({ name, ok, level, detail });
      add("home", fs.existsSync(home), fs.existsSync(home) ? home : `${home} missing; run \`todocue install\``);
      add("database", fs.existsSync(paths.database), fs.existsSync(paths.database) ? paths.database : "no database yet (created on first runtime start)");
      const la = await launchAgentStatus(paths);
      add("launchAgent", la.installed && la.loaded, la.detail, la.installed ? (la.loaded ? "ok" : "warn") : "warn");
      const notifier = new HelperNotifier({ searchPaths: [...defaultHelperCandidates(home), path.join(repoRoot(), "apps/macos/build/TodoCueNotifier.app/Contents/MacOS/TodoCueNotifier")] });
      const helper = notifier.resolveHelper();
      add("notifierHelper", !!helper, helper ?? "TodoCueNotifier not found; reminders fall back to osascript (no click-through). Run `npm run macos:build && todocue install`");
      const alive = await isRuntimeAlive(paths);
      add("runtime", !!alive, alive ? `reachable at ${alive.baseUrl} (pid ${alive.pid})` : "not reachable; run `todocue service start` or `todocue serve`", alive ? "ok" : "error");
      let report: unknown = null;
      if (alive) {
        const client = TodoCueClient.fromHome(home)!;
        if (opts.requestNotifications) {
          const auth = await client.requestNotificationAuthorization();
          add("notificationRequest", auth.authorization === "authorized" || auth.authorization === "provisional", `authorization now: ${auth.authorization}`);
        }
        const r = await client.doctor();
        report = r;
        for (const c of r.checks) if (!checks.some((x) => x.name === c.name)) checks.push(c);
        add("reminders", r.counts.failedReminders === 0, `${r.counts.pendingReminders} pending, ${r.counts.failedReminders} failed`);
        add("timezone", true, r.timezone);
      } else if (helper) {
        const s = await notifier.status();
        add("notificationAuthorization", s.authorization === "authorized" || s.authorization === "provisional", `authorization: ${s.authorization}`, s.authorization === "denied" ? "error" : "warn");
      }
      const ok = checks.every((c) => c.level !== "error");
      print(ctx.out(), { ok, cliVersion: RUNTIME_VERSION, node: process.version, home, checks, runtime: report }, () =>
        [
          `TodoCue doctor · cli ${RUNTIME_VERSION} · node ${process.version}`,
          ...checks.map((c) => `${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.name.padEnd(26)} ${c.detail}`),
          ok ? "\nall critical checks passed" : "\nsome checks failed",
        ].join("\n"),
      );
      if (!ok) process.exitCode = 1;
    });

  program
    .command("export")
    .description("export all tasks, series and reminders as JSON (works offline)")
    .option("-o, --out <file>")
    .action(async (opts) => {
      const home = resolveHome(ctx.home());
      const paths = runtimePaths(home);
      let bundle: unknown;
      if (await isRuntimeAlive(paths)) bundle = await TodoCueClient.fromHome(home)!.export();
      else {
        if (!fs.existsSync(paths.database)) throw new TodoCueError(ErrorCodes.NOT_FOUND, `no database at ${paths.database}`);
        const { db } = openDatabase({ path: paths.database, backupDir: paths.backups });
        bundle = new TaskEngine({ db }).exportBundle();
        db.close();
      }
      const text = JSON.stringify(bundle, null, 2) + "\n";
      if (opts.out) {
        fs.writeFileSync(opts.out, text);
        print(ctx.out(), { out: opts.out }, () => `exported to ${opts.out}`);
      } else process.stdout.write(text);
    });
}
