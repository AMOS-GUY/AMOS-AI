#!/usr/bin/env node
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { resolvePaths } from "../config/paths.ts";
import { formatErrorForUser } from "../core/errors.ts";
import { createRuntime, defaultRuntimeInputs, type RuntimeInputs } from "../runtime.ts";
import { VERSION } from "../version.ts";
import { formatResults, runDoctor } from "./doctor.ts";

const HELP = `amos ${VERSION} — AMOS AI command line (M0: environment tools only)

Usage:
  amos doctor [--json]     Check this machine's setup (read-only, no network)
  amos paths [--json]      Show where AMOS keeps config, data and logs
  amos config show         Print the effective configuration (no secret values)
  amos version             Print the version
  amos help [command]      Show help (also: amos <command> --help)
`;

interface CommandSpec {
  /** Words after "amos" that name the command, e.g. ["config", "show"]. */
  readonly words: readonly string[];
  readonly json: boolean;
  readonly help: string;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    words: ["doctor"],
    json: true,
    help: `Usage: amos doctor [--json]

Checks this machine's setup: Node.js version, SQLite features, configuration, secrets file
permissions, data/log directories, unknown AMOS_* variables, and optional tools (git, python,
bubblewrap). Read-only: it creates and changes nothing and does not use the network.

Exit status: 0 if no check failed, 1 if any check failed, 2 for usage errors.
`,
  },
  {
    words: ["paths"],
    json: true,
    help: `Usage: amos paths [--json]

Prints where AMOS keeps its config file, secrets file, database and logs on this OS.
Override with AMOS_CONFIG_DIR, AMOS_DATA_DIR and AMOS_STATE_DIR (absolute paths).
`,
  },
  {
    words: ["config", "show"],
    json: false,
    help: `Usage: amos config show

Prints the effective configuration (defaults < config.yaml < AMOS_* variables), the names of
the entries in secrets.env (never their values), and which variables overrode a setting.
Exit status 1 if the configuration or secrets file is invalid.
`,
  },
  { words: ["version"], json: false, help: "Usage: amos version\n\nPrints the AMOS version.\n" },
];

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

function findCommand(positionals: readonly string[]): CommandSpec | undefined {
  return COMMANDS.find((c) => c.words.every((w, i) => positionals[i] === w));
}

/** Returns the process exit code. Never calls process.exit itself, so it is testable. */
export function runCli(argv: readonly string[], inputs: RuntimeInputs, io: CliIo): number {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  const positionals = parsed.positionals;
  const wantsHelp = parsed.values.help === true || positionals[0] === "help";
  const words = positionals[0] === "help" ? positionals.slice(1) : positionals;
  const spec = findCommand(words);

  // Help never runs the command (`amos doctor --help` prints doctor's help and exits 0).
  if (wantsHelp) {
    if (words.length === 0) {
      io.stdout.write(HELP);
      return 0;
    }
    if (spec && words.length === spec.words.length) {
      io.stdout.write(spec.help);
      return 0;
    }
    io.stderr.write(`No help for unknown command: ${words.join(" ")}\n\n${HELP}`);
    return 2;
  }
  if (positionals.length === 0) {
    io.stdout.write(HELP);
    return 0;
  }
  if (!spec) {
    const hint = positionals[0] === "config" ? "Did you mean: amos config show\n\n" : "";
    io.stderr.write(`Unknown command: ${positionals.join(" ")}\n${hint}\n${HELP}`);
    return 2;
  }
  if (positionals.length > spec.words.length) {
    io.stderr.write(
      `Unexpected argument: ${positionals.slice(spec.words.length).join(" ")}\n\n${spec.help}`,
    );
    return 2;
  }
  const json = parsed.values.json === true;
  if (json && !spec.json) {
    io.stderr.write(`amos ${spec.words.join(" ")} does not support --json.\n\n${spec.help}`);
    return 2;
  }
  const command = spec.words.join(" ");

  try {
    switch (command) {
      case "version":
        io.stdout.write(`${VERSION}\n`);
        return 0;
      case "paths": {
        const paths = resolvePaths(inputs);
        io.stdout.write(json ? `${JSON.stringify(paths, null, 2)}\n` : stringify(paths));
        return 0;
      }
      case "doctor": {
        const results = runDoctor({
          paths: resolvePaths(inputs),
          env: inputs.env,
          platform: inputs.platform,
          nodeVersion: process.version,
        });
        io.stdout.write(
          json ? `${JSON.stringify(results, null, 2)}\n` : `${formatResults(results)}\n`,
        );
        return results.some((r) => r.status === "fail") ? 1 : 0;
      }
      case "config show": {
        const runtime = createRuntime({ ...inputs, consoleStream: null });
        const output = {
          source: runtime.loaded.file ?? "(defaults — no config file)",
          envOverrides: runtime.loaded.envOverrides,
          secretsFile: runtime.secrets.fileLoaded ? runtime.paths.secretsFile : "(none)",
          secretNames: runtime.secrets.fileKeyNames(),
          config: runtime.loaded.config,
        };
        io.stdout.write(stringify(output));
        runtime.logger.close();
        return 0;
      }
    }
  } catch (error) {
    io.stderr.write(`${formatErrorForUser(error)}\n`);
    return 1;
  }
  // Unreachable unless COMMANDS and the switch disagree — a bug, reported as such.
  io.stderr.write(`internal error: command "${command}" has no handler\n`);
  return 70;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
}

// Run only when executed directly, not when imported by tests.
if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), defaultRuntimeInputs(), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
