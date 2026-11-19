import os from "node:os";
import { type LoadedConfig, loadConfig } from "./config/load.ts";
import { type AmosPaths, resolvePaths } from "./config/paths.ts";
import { loadSecrets, type SecretStore } from "./config/secrets.ts";
import { FileSink } from "./logging/file-sink.ts";
import { Logger, type LogSink, StreamSink } from "./logging/logger.ts";
import { Redactor } from "./logging/redact.ts";

/**
 * Startup wiring shared by every entry point (CLI now, amosd in M1): resolve paths, load and
 * validate config, load secrets, build the logger. Inputs are explicit so tests can run it against
 * temporary directories and a fake environment.
 */

export interface RuntimeInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  /** Where human-facing log output goes; null disables console logging. */
  readonly consoleStream?: NodeJS.WritableStream | null;
}

export interface Runtime {
  readonly paths: AmosPaths;
  readonly loaded: LoadedConfig;
  readonly secrets: SecretStore;
  readonly redactor: Redactor;
  readonly logger: Logger;
}

export function defaultRuntimeInputs(): RuntimeInputs {
  return { env: process.env, platform: process.platform, homeDir: os.homedir() };
}

export function createRuntime(inputs: RuntimeInputs): Runtime {
  const paths = resolvePaths(inputs);
  const loaded = loadConfig({ configFile: paths.configFile, env: inputs.env });
  const redactor = new Redactor();
  const secrets = loadSecrets({
    file: paths.secretsFile,
    env: inputs.env,
    platform: inputs.platform,
    redactor,
  });

  const sinks: LogSink[] = [];
  if (inputs.consoleStream !== null) sinks.push(new StreamSink(inputs.consoleStream));
  const fileSettings = loaded.config.logging.file;
  if (fileSettings.enabled) {
    sinks.push(
      new FileSink({
        dir: paths.logDir,
        maxBytes: fileSettings.maxBytes,
        maxFiles: fileSettings.maxFiles,
      }),
    );
  }
  const logger = new Logger({ level: loaded.config.logging.level, sinks, redactor });
  return { paths, loaded, secrets, redactor, logger };
}
