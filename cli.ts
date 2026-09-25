import "./utils/legacyEnv.ts";
import { basename } from "node:path";
import arg from "arg";
import pc from "picocolors";
import { runCli as runAuthCli } from "./commands/auth.ts";
import { runCli as runConfigCli } from "./commands/config.ts";
import { runCli as runConsoleCli } from "./commands/console.ts";
import { runCli as runGhaCli } from "./commands/gha.ts";
import { runCli as runInitCli } from "./commands/init.ts";
import { runCli as runMcpCli } from "./commands/mcp.ts";
import { runCli as runSecretCli } from "./commands/secret.ts";
import { runCli as runWatchCli } from "./commands/watch.ts";

const VERSION = process.env.CLI_VERSION ?? "0.0.0";
const bin = basename(process.argv[1] || "");
const PROG = bin === "pf" || bin === "pullfrog" ? bin : "pullfrog";
const rawArgs = process.argv.slice(2);

function printMainUsage(stream: typeof console.log): void {
  stream(`usage: ${PROG} <command>\n`);
  stream("commands:");
  stream("  config      inspect and change repository or organization settings");
  stream("  console     open the repository or organization console");
  stream("  secret      list secret names, save or delete scoped credentials");
  stream("  init        install pullfrog on the current repository and open its dashboard");
  stream("  auth        manage provider credentials for the current repository");
  stream("  watch       stream a PR's activity as one JSON line per event");
  stream("  mcp         run a stdio MCP server exposing PR activity as an agent tool");
  stream("");
  stream("global options:");
  stream("  -h, --help      show help");
  stream("  -v, --version   show version");
}

function parseGlobalArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "--version": Boolean,
      "-h": "--help",
      "-v": "--version",
    },
    {
      argv: args,
      stopAtPositional: true,
    }
  );
}

function exitWithUsageError(message: string): never {
  console.error(`${message}\n`);
  printMainUsage(console.error);
  process.exit(1);
}

async function run(): Promise<void> {
  let globalParsed: ReturnType<typeof parseGlobalArgs>;
  try {
    globalParsed = parseGlobalArgs(rawArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithUsageError(message);
  }

  if (globalParsed["--version"]) {
    console.log(VERSION);
    process.exit(0);
  }

  const command = globalParsed._[0];
  const commandArgs = globalParsed._.slice(1);

  if (!command) {
    if (globalParsed["--help"]) {
      console.log(`${pc.bold("pullfrog")} v${VERSION}\n`);
      printMainUsage(console.log);
      process.exit(0);
    }
    printMainUsage(console.log);
    process.exit(0);
  }

  if (command === "init") {
    await runInitCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (command === "config" || command === "console" || command === "secret") {
    const runCommand =
      command === "config" ? runConfigCli : command === "secret" ? runSecretCli : runConsoleCli;
    await runCommand({ args: commandArgs, prog: PROG, showHelp: globalParsed["--help"] === true });
    return;
  }

  if (command === "gha") {
    await runGhaCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (command === "auth") {
    await runAuthCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (command === "mcp") {
    await runMcpCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (command === "watch") {
    await runWatchCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (globalParsed["--help"]) {
    printMainUsage(console.log);
    process.exit(0);
  }

  console.error(`unknown command: ${pc.bold(command)}\n`);
  printMainUsage(console.error);
  process.exit(1);
}

try {
  await run();
  // exit explicitly rather than waiting for the event loop to drain. a leaked
  // handle — a self-daemonized `pullfrog_shell` descendant is the one we've
  // actually seen — otherwise strands a finished job for hours. safe here and
  // nowhere earlier: `run()` has fully resolved, so `main()`'s `finally` (the
  // end-of-run PATCH, artifact persistence, status checks) has already
  // completed, and @actions/core writes its outputs synchronously. see #1087.
  process.exit(process.exitCode ?? 0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}
