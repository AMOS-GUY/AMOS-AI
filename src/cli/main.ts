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
  amos help                Show this help
`;

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
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
  const [command, sub] = parsed.positionals;
  const json = parsed.values.json === true;

  try {
    switch (command) {
      case undefined:
      case "help":
        io.stdout.write(HELP);
        return 0;
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
      case "config": {
        if (sub !== "show") break;
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
  io.stderr.write(`Unknown command: ${[command, sub].filter(Boolean).join(" ")}\n\n${HELP}`);
  return 2;
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
