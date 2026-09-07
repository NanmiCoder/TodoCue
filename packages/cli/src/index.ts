#!/usr/bin/env node
import { Command } from "commander";
import { ErrorCodes, RUNTIME_VERSION, TodoCueError } from "@todocue/shared";
import { TodoCueClient, resolveHome } from "@todocue/server";
import { registerTaskCommands } from "./commands/tasks.js";
import { registerOpsCommands } from "./commands/ops.js";
import { serveMcp } from "./commands/mcp.js";
import { printError } from "./output.js";

const program = new Command();
program
  .name("todocue")
  .description("TodoCue: local task runtime for humans (macOS UI) and agents (CLI / MCP / Local API)")
  .version(RUNTIME_VERSION)
  .option("--json", "machine-readable JSON output")
  .option("--home <dir>", "TodoCue home (default ~/.todocue or $TODOCUE_HOME)")
  .showHelpAfterError();

const globals = () => program.opts<{ json?: boolean; home?: string }>();
const out = () => ({ json: !!globals().json });
const home = () => globals().home;
const client = (): TodoCueClient => {
  const c = TodoCueClient.fromHome(resolveHome(home()));
  if (!c) {
    throw new TodoCueError(ErrorCodes.UNAVAILABLE, "TodoCue runtime is not running (no connection file)", {
      hint: "run `todocue service start`, or `todocue serve` in a terminal, or `todocue install` for first-time setup",
    });
  }
  return c;
};

registerTaskCommands(program, { client, out });
registerOpsCommands(program, { client, out, home });
program
  .command("mcp")
  .description("run the MCP server over stdio (for coding agents)")
  .action(() => {
    serveMcp(client);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(out(), err);
  process.exitCode = 1;
});
