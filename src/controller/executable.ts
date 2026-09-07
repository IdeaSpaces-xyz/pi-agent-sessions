import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ControllerRuntime, PiExecutableConfig, ResolvedLaunch } from "./types.js";

export function resolvePiLaunch(
  explicit?: PiExecutableConfig,
  runtime: ControllerRuntime = currentRuntime(),
): ResolvedLaunch {
  if (explicit !== undefined) {
    validateArg(explicit.command, "executable.command");
    const argvPrefix = [...(explicit.argvPrefix ?? [])];
    argvPrefix.forEach((arg, index) => validateArg(arg, `executable.argvPrefix[${index}]`, true));
    return {
      command: resolveExecutable(explicit.command, runtime.env, runtime.platform),
      argvPrefix,
      source: "explicit",
    };
  }

  const entry = runtime.argv[1];
  if (entry) {
    const resolvedEntry = resolve(entry);
    if (existsSync(resolvedEntry) && isPiCliEntrypoint(resolvedEntry)) {
      return {
        command: resolveExecutable(runtime.execPath, runtime.env, runtime.platform),
        argvPrefix: [...runtime.execArgv, realpathSync(resolvedEntry)],
        source: "current-cli",
      };
    }
  }

  if (isCurrentPackagedPi(runtime)) {
    return {
      command: resolveExecutable(runtime.execPath, runtime.env, runtime.platform),
      argvPrefix: [],
      source: "packaged",
    };
  }

  throw new Error("Unable to resolve Pi executable; provide executable.command and optional argvPrefix");
}

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  validateArg(command, "executable.command");
  const hasSeparator = command.includes("/") || command.includes("\\");
  if (isAbsolute(command) || hasSeparator) return requireExecutable(resolve(command), platform);

  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (!pathValue) throw new Error(`Executable not found on PATH: ${command}`);
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" ? `${command}${extension}` : command);
      try {
        return requireExecutable(candidate, platform);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`Executable not found on PATH: ${command}`);
}

function requireExecutable(path: string, platform: NodeJS.Platform): string {
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isFile()) throw new Error("not a file");
    accessSync(real, platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`Executable is missing or not runnable: ${path}`);
  }
  return real;
}

function isPiCliEntrypoint(entry: string): boolean {
  let directory = dirname(entry);
  while (true) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (manifest.name === "@earendil-works/pi-coding-agent") return true;
      } catch {
        return false;
      }
    }
    const parent = dirname(directory);
    if (parent === directory || !directory.includes(sep)) return false;
    directory = parent;
  }
}

function isCurrentPackagedPi(runtime: ControllerRuntime): boolean {
  if (runtime.versions.bun === undefined) return false;
  const entry = runtime.argv[1];
  if (!entry) return true;
  try {
    return realpathSync(resolve(entry)) === realpathSync(runtime.execPath);
  } catch {
    return false;
  }
}

function validateArg(value: string, field: string, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.includes("\0")) {
    throw new Error(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"} without NUL bytes`);
  }
}

function currentRuntime(): ControllerRuntime {
  return {
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    env: process.env,
    platform: process.platform,
    versions: process.versions,
  };
}
