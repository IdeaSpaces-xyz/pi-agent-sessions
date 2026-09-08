import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentSessionControllerConfig,
  ControllerLimits,
  ResolvedControllerConfig,
} from "./types.js";
import { resolvePiLaunch } from "./executable.js";

export const DEFAULT_LIMITS: Readonly<ControllerLimits> = Object.freeze({
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  settlementTimeoutMs: 10 * 60_000,
  dialogTimeoutMs: 10 * 60_000,
  closeGraceMs: 5_000,
  killGraceMs: 2_000,
  maxLineBytes: 1024 * 1024,
  maxRecentEvents: 200,
  maxTurns: 50,
  maxStderrBytes: 32 * 1024,
  maxReplyChars: 64 * 1024,
  maxDialogs: 16,
  maxChildren: 4,
});

const LIMIT_BOUNDS: Record<keyof ControllerLimits, readonly [number, number]> = {
  startupTimeoutMs: [10, 30_000],
  requestTimeoutMs: [10, 120_000],
  settlementTimeoutMs: [10, 3_600_000],
  dialogTimeoutMs: [10, 3_600_000],
  closeGraceMs: [0, 30_000],
  killGraceMs: [10, 10_000],
  maxLineBytes: [256, 16 * 1024 * 1024],
  maxRecentEvents: [1, 1_000],
  maxTurns: [1, 500],
  maxStderrBytes: [256, 128 * 1024],
  maxReplyChars: [256, 256 * 1024],
  maxDialogs: [1, 64],
  maxChildren: [1, 8],
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
  const resumeSession = resolveResumeSession(input.resumeSession, target);

  validateOptionalText(input.model, "model");
  validateOptionalText(input.thinking, "thinking");
  validateOptionalText(input.sessionName, "sessionName");
  if (input.sessionName !== undefined && input.sessionName.trim().length > 200) {
    throw new Error("sessionName cannot exceed 200 characters");
  }
  if (input.sessionName !== undefined && resumeSession) {
    throw new Error("sessionName cannot be combined with resumeSession");
  }
  validateEnvironment(input.env);
  requireSavedTrust(input, target, agentDir);

  return {
    ...input,
    target,
    packageDir,
    agentDir,
    extensionPaths,
    skillPaths,
    resumeSession,
    launch: resolvePiLaunch(input.executable),
    limits: validateLimits(input.limits),
  };
}

function resolveResumeSession(
  input: AgentSessionControllerConfig["resumeSession"],
  target: string,
): ResolvedControllerConfig["resumeSession"] {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object") throw new Error("resumeSession must be an object");
  validateText(input.path, "resumeSession.path");
  validateText(input.conversationId, "resumeSession.conversationId");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/.test(input.conversationId)) {
    throw new Error("resumeSession.conversationId is invalid");
  }
  let path: string;
  let stat: ReturnType<typeof statSync>;
  try {
    path = realpathSync(resolve(input.path));
    stat = statSync(path);
  } catch {
    throw new Error(`resumeSession.path does not exist: ${resolve(input.path)}`);
  }
  if (!stat.isFile()) throw new Error("resumeSession.path must be a regular file");
  if (stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error("resumeSession.path must be between 1 byte and 16 MiB");
  }
  let header: Record<string, unknown>;
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    const parsed = firstLine ? JSON.parse(firstLine) as unknown : undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid header");
    header = parsed as Record<string, unknown>;
  } catch {
    throw new Error("resumeSession.path has an invalid session header");
  }
  if (header.type !== "session" || header.id !== input.conversationId || typeof header.cwd !== "string") {
    throw new Error("resumeSession.path header does not match conversationId");
  }
  try {
    if (realpathSync(resolve(header.cwd)) !== target) throw new Error("cwd mismatch");
  } catch {
    throw new Error("resumeSession.path header does not belong to target");
  }
  return {
    path,
    conversationId: input.conversationId,
    device: stat.dev,
    inode: stat.ino,
  };
}

function requireSavedTrust(
  input: AgentSessionControllerConfig,
  target: string,
  agentDir: string | undefined,
): void {
  if (input.trust.mode !== "saved" || !hasTrustRequiringProjectResources(target)) return;
  const configuredAgentDir =
    agentDir ?? input.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (readSavedTrust(configuredAgentDir, target) !== true) {
    throw new Error(
      `Project resources are not positively trusted for ${target}; save a Pi trust decision or use explicit approval`,
    );
  }
}

function hasTrustRequiringProjectResources(target: string): boolean {
  const projectConfig = join(target, ".pi");
  const projectEntries = ["settings.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];
  if (projectEntries.some((entry) => existsSync(join(projectConfig, entry)))) return true;

  const userSkills = join(realpathOrResolve(process.env.HOME ?? homedir()), ".agents", "skills");
  let current = target;
  while (true) {
    const skills = join(current, ".agents", "skills");
    if (skills !== userSkills && existsSync(skills)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readSavedTrust(agentDir: string, target: string): boolean | null {
  const trustPath = join(resolve(agentDir), "trust.json");
  if (!existsSync(trustPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(trustPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read trust store ${trustPath}: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${trustPath}: expected an object`);
  }

  const entries = parsed as Record<string, unknown>;
  for (const [path, decision] of Object.entries(entries)) {
    if (decision !== true && decision !== false && decision !== null) {
      throw new Error(`Invalid trust store ${trustPath}: value for ${JSON.stringify(path)} must be true, false, or null`);
    }
  }
  let current = target;
  while (true) {
    const decision = entries[current];
    if (decision === true || decision === false) return decision;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
