import type { AgentSessionControllerConfig, ControllerLimits, PiExecutableConfig } from "../controller/types.js";
import type { AgentDiscoveryOptions } from "../discovery/types.js";
import type { ConversationCatalogLimits } from "../conversations/types.js";
import type { OwnedAgentSessionsConfig } from "../sessions/types.js";

export const HOST_CONFIG_ENV = "PI_AGENT_SESSIONS_CONFIG";
export const DEPTH_ENV = "PI_AGENT_SESSION_DEPTH";
export const COLLECTION_FLAG = "agent-collection";
export const APPROVE_FLAG = "agent-approve-project-resources";

export interface ExtensionFlagReader {
  getFlag(name: string): boolean | string | undefined;
}

export interface ParsedExtensionConfig {
  sessions: OwnedAgentSessionsConfig;
  source: "host" | "terminal" | "defaults";
}

export function resolveExtensionConfig(
  pi: ExtensionFlagReader,
  env: NodeJS.ProcessEnv = process.env,
): ParsedExtensionConfig {
  const depth = parseDepth(env[DEPTH_ENV]);
  const hostValue = env[HOST_CONFIG_ENV];
  if (hostValue !== undefined) {
    return {
      sessions: { ...parseHostConfig(hostValue), depth },
      source: "host",
    };
  }

  const collection = pi.getFlag(COLLECTION_FLAG);
  const approve = pi.getFlag(APPROVE_FLAG);
  return {
    sessions: {
      collectionRoot: typeof collection === "string" && collection.trim() !== "" ? collection : undefined,
      approveProjectResources: approve === true,
      depth,
    },
    source: typeof collection === "string" && collection.trim() !== "" ? "terminal" : "defaults",
  };
}

export function parseDepth(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${DEPTH_ENV} must be a non-negative integer`);
  const depth = Number(value);
  if (!Number.isSafeInteger(depth) || depth > 32) throw new Error(`${DEPTH_ENV} must be between 0 and 32`);
  return depth;
}

function parseHostConfig(value: string): Omit<OwnedAgentSessionsConfig, "depth"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${HOST_CONFIG_ENV} must be valid JSON: ${errorMessage(error)}`);
  }
  const object = requireObject(parsed, HOST_CONFIG_ENV);
  rejectUnknownKeys(object, [
    "collectionRoot",
    "approveProjectResources",
    "discovery",
    "conversations",
    "controller",
  ], HOST_CONFIG_ENV);

  return {
    collectionRoot: optionalString(object.collectionRoot, "collectionRoot"),
    approveProjectResources: optionalBoolean(object.approveProjectResources, "approveProjectResources"),
    discovery: parseDiscovery(object.discovery),
    conversations: parseConversationLimits(object.conversations),
    controller: parseController(object.controller),
  };
}

function parseDiscovery(value: unknown): AgentDiscoveryOptions | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, "discovery");
  rejectUnknownKeys(object, ["maxAgents", "maxScannedEntries"], "discovery");
  return {
    maxAgents: optionalNumber(object.maxAgents, "discovery.maxAgents"),
    maxScannedEntries: optionalNumber(object.maxScannedEntries, "discovery.maxScannedEntries"),
  };
}

function parseConversationLimits(value: unknown): Partial<ConversationCatalogLimits> | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, "conversations");
  const keys: Array<keyof ConversationCatalogLimits> = [
    "maxConversations",
    "maxScannedEntries",
    "maxFileBytes",
    "maxPreviewChars",
    "maxQueryChars",
  ];
  rejectUnknownKeys(object, keys, "conversations");
  const limits: Partial<ConversationCatalogLimits> = {};
  for (const key of keys) {
    const number = optionalNumber(object[key], `conversations.${key}`);
    if (number !== undefined) limits[key] = number;
  }
  return limits;
}

function parseController(
  value: unknown,
): Omit<AgentSessionControllerConfig, "target" | "trust" | "model" | "thinking" | "sessionName"> | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, "controller");
  rejectUnknownKeys(object, [
    "executable",
    "packageDir",
    "agentDir",
    "extensionPaths",
    "skillPaths",
    "env",
    "limits",
  ], "controller");
  return {
    executable: parseExecutable(object.executable),
    packageDir: optionalString(object.packageDir, "controller.packageDir"),
    agentDir: optionalString(object.agentDir, "controller.agentDir"),
    extensionPaths: optionalStringArray(object.extensionPaths, "controller.extensionPaths"),
    skillPaths: optionalStringArray(object.skillPaths, "controller.skillPaths"),
    env: optionalEnvironment(object.env),
    limits: parseLimits(object.limits),
  };
}

function parseExecutable(value: unknown): PiExecutableConfig | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, "controller.executable");
  rejectUnknownKeys(object, ["command", "argvPrefix"], "controller.executable");
  const command = optionalString(object.command, "controller.executable.command");
  if (!command) throw new Error("controller.executable.command is required");
  return {
    command,
    argvPrefix: optionalStringArray(object.argvPrefix, "controller.executable.argvPrefix"),
  };
}

function parseLimits(value: unknown): Partial<ControllerLimits> | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, "controller.limits");
  const keys: Array<keyof ControllerLimits> = [
    "startupTimeoutMs",
    "requestTimeoutMs",
    "settlementTimeoutMs",
    "dialogTimeoutMs",
    "closeGraceMs",
    "killGraceMs",
    "maxLineBytes",
    "maxRecentEvents",
    "maxTurns",
    "maxStderrBytes",
    "maxReplyChars",
    "maxDialogs",
    "maxChildren",
  ];
  rejectUnknownKeys(object, keys, "controller.limits");
  const limits: Partial<ControllerLimits> = {};
  for (const key of keys) {
    const number = optionalNumber(object[key], `controller.limits.${key}`);
    if (number !== undefined) limits[key] = number;
  }
  return limits;
}

function optionalEnvironment(value: unknown): Readonly<Record<string, string | undefined>> | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, "controller.env");
  const result: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(object)) {
    if (item === null) {
      result[key] = undefined;
      continue;
    }
    if (typeof item !== "string") {
      throw new Error(`controller.env.${key} must be a string or null`);
    }
    result[key] = item;
  }
  return result;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(object).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown field: ${unknown[0]}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
