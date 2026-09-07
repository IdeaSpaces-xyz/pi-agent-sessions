import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  AgentSessionControllerConfig,
  ControllerLimits,
  ResolvedControllerConfig,
  ResolvedLaunch,
} from "./types.js";
import { resolvePiLaunch } from "./executable.js";

export const DEFAULT_LIMITS: Readonly<ControllerLimits> = Object.freeze({
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  settlementTimeoutMs: 10 * 60_000,
  closeGraceMs: 2_000,
  killGraceMs: 1_000,
  maxLineBytes: 1024 * 1024,
  maxRecentEvents: 200,
  maxTurns: 50,
  maxStderrBytes: 64 * 1024,
  maxReplyChars: 64 * 1024,
  maxChildren: 4,
});

const LIMIT_BOUNDS: Record<keyof ControllerLimits, readonly [number, number]> = {
  startupTimeoutMs: [10, 120_000],
  requestTimeoutMs: [10, 120_000],
  settlementTimeoutMs: [10, 3_600_000],
  closeGraceMs: [0, 60_000],
  killGraceMs: [10, 60_000],
  maxLineBytes: [256, 16 * 1024 * 1024],
  maxRecentEvents: [1, 2_000],
  maxTurns: [1, 500],
  maxStderrBytes: [256, 4 * 1024 * 1024],
  maxReplyChars: [256, 4 * 1024 * 1024],
  maxChildren: [1, 32],
};

export function validateLimits(input: Partial<ControllerLimits> = {}): ControllerLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(LIMIT_BOUNDS) as Array<keyof ControllerLimits>) {
    const value = limits[key];
    const [minimum, maximum] = LIMIT_BOUNDS[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  return limits;
}

export function resolveControllerConfig(
  input: AgentSessionControllerConfig,
  launchOverride?: ResolvedLaunch,
): ResolvedControllerConfig {
  if (!input || typeof input !== "object") throw new Error("Controller config is required");
  if (input.trust?.mode !== "saved" && input.trust?.mode !== "explicit") {
    throw new Error("trust must explicitly use saved or explicit mode");
  }

  const target = resolveExistingDirectory(input.target, "target");
  const packageDir = input.packageDir === undefined ? undefined : resolveExistingDirectory(input.packageDir, "packageDir");
  const agentDir = input.agentDir === undefined ? undefined : resolveExistingDirectory(input.agentDir, "agentDir");
  const extensionPaths = resolvePaths(input.extensionPaths, "extensionPaths");
  const skillPaths = resolvePaths(input.skillPaths, "skillPaths");

  validateOptionalText(input.model, "model");
  validateOptionalText(input.thinking, "thinking");
  validateEnvironment(input.env);

  return {
    ...input,
    target,
    packageDir,
    agentDir,
    extensionPaths,
    skillPaths,
    launch: launchOverride ?? resolvePiLaunch(input.executable),
    limits: validateLimits(input.limits),
  };
}

function resolveExistingDirectory(path: string, field: string): string {
  validateText(path, field);
  const absolute = isAbsolute(path) ? path : resolve(path);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new Error(`${field} does not exist: ${absolute}`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${field} must be a directory: ${real}`);
  return real;
}

function resolvePaths(paths: readonly string[] | undefined, field: string): string[] | undefined {
  if (paths === undefined) return undefined;
  if (!Array.isArray(paths)) throw new Error(`${field} must be an array`);
  if (paths.length > 128) throw new Error(`${field} cannot contain more than 128 paths`);
  const resolved = paths.map((path, index) => {
    validateText(path, `${field}[${index}]`);
    const absolute = isAbsolute(path) ? path : resolve(path);
    try {
      return realpathSync(absolute);
    } catch {
      throw new Error(`${field}[${index}] does not exist: ${absolute}`);
    }
  });
  return [...new Set(resolved)];
}

function validateEnvironment(env: Readonly<Record<string, string | undefined>> | undefined): void {
  if (env === undefined) return;
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env must be an object");
  const entries = Object.entries(env);
  if (entries.length > 256) throw new Error("env cannot contain more than 256 entries");
  for (const [key, value] of entries) {
    if (!key || key.includes("=") || key.includes("\0")) throw new Error(`Invalid environment key: ${JSON.stringify(key)}`);
    if (value !== undefined && (typeof value !== "string" || value.includes("\0"))) {
      throw new Error(`Environment value for ${key} must be a string without NUL bytes`);
    }
  }
}

function validateOptionalText(value: string | undefined, field: string): void {
  if (value !== undefined) validateText(value, field);
}

function validateText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string without NUL bytes`);
  }
}
