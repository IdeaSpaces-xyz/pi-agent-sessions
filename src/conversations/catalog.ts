import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentConversation,
  AgentConversationCatalog,
  ConversationCatalogLimits,
  ConversationCatalogOptions,
} from "./types.js";

export const DEFAULT_CONVERSATION_LIMITS: Readonly<ConversationCatalogLimits> = Object.freeze({
  maxConversations: 50,
  maxScannedEntries: 500,
  maxFileBytes: 4 * 1024 * 1024,
  maxPreviewChars: 240,
  maxQueryChars: 200,
});

const LIMIT_BOUNDS: Record<keyof ConversationCatalogLimits, readonly [number, number]> = {
  maxConversations: [1, 100],
  maxScannedEntries: [1, 2_000],
  maxFileBytes: [1_024, 16 * 1024 * 1024],
  maxPreviewChars: [32, 1_000],
  maxQueryChars: [1, 500],
};

export function validateConversationLimits(
  input: Partial<ConversationCatalogLimits> = {},
): ConversationCatalogLimits {
  const limits = { ...DEFAULT_CONVERSATION_LIMITS, ...input };
  for (const key of Object.keys(LIMIT_BOUNDS) as Array<keyof ConversationCatalogLimits>) {
    const value = limits[key];
    const [minimum, maximum] = LIMIT_BOUNDS[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  if (limits.maxConversations > limits.maxScannedEntries) {
    throw new Error("maxConversations cannot exceed maxScannedEntries");
  }
  return limits;
}

export function resolveAgentSessionDir(
  target: string,
  options: Pick<ConversationCatalogOptions, "agentDir" | "env"> = {},
): string {
  const canonicalTarget = realpathSync(resolve(target));
  const configuredEnvironment = effectiveEnvironmentValue(options.env, "PI_CODING_AGENT_SESSION_DIR");
  if (configuredEnvironment) return resolveConfiguredPath(configuredEnvironment, canonicalTarget);

  return defaultSessionDir(canonicalTarget, options.agentDir);
}

export function listAgentConversations(
  agent: string,
  target: string,
  options: ConversationCatalogOptions = {},
): AgentConversationCatalog {
  validateName(agent, "agent");
  const limits = validateConversationLimits(options.limits);
  const query = normalizeQuery(options.query, limits.maxQueryChars);
  const canonicalTarget = realpathSync(resolve(target));
  const configuredDir = resolveAgentSessionDir(canonicalTarget, options);
  if (!existsSync(configuredDir)) {
    return { agent, conversations: [], scannedEntries: 0, skippedEntries: 0, truncated: false };
  }

  const sessionDir = realpathSync(configuredDir);
  const entries = readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".jsonl"))
    .sort((left, right) => right.name.localeCompare(left.name));
  const candidates = entries.slice(0, limits.maxScannedEntries);
  const conversations: AgentConversation[] = [];
  const ids = new Set<string>();
  let skippedEntries = 0;

  for (const entry of candidates) {
    if (!entry.isFile()) {
      skippedEntries += 1;
      continue;
    }
    const candidate = join(sessionDir, entry.name);
    const parsed = readConversation(candidate, sessionDir, canonicalTarget, limits);
    if (!parsed || ids.has(parsed.conversationId)) {
      skippedEntries += 1;
      continue;
    }
    ids.add(parsed.conversationId);
    if (query && !conversationMatches(parsed, query)) continue;
    if (conversations.length < limits.maxConversations) conversations.push(parsed);
  }

  return {
    agent,
    conversations,
    scannedEntries: candidates.length,
    skippedEntries,
    truncated: entries.length > candidates.length || conversations.length === limits.maxConversations && candidates.length > conversations.length,
  };
}

function readConversation(
  candidate: string,
  sessionDir: string,
  canonicalTarget: string,
  limits: ConversationCatalogLimits,
): AgentConversation | undefined {
  let real: string;
  let stat: ReturnType<typeof statSync>;
  try {
    real = realpathSync(candidate);
    if (!containedBy(sessionDir, real)) return undefined;
    stat = statSync(real);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > limits.maxFileBytes) return undefined;

  let lines: string[];
  try {
    lines = readFileSync(real, "utf8").split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
  if (lines.length === 0) return undefined;

  let header: Record<string, unknown>;
  try {
    const parsed = JSON.parse(lines[0]!) as unknown;
    if (!isRecord(parsed)) return undefined;
    header = parsed;
  } catch {
    return undefined;
  }
  if (header.type !== "session" || !validId(header.id) || typeof header.cwd !== "string") return undefined;
  let headerCwd: string;
  try {
    headerCwd = realpathSync(resolve(header.cwd));
  } catch {
    return undefined;
  }
  if (headerCwd !== canonicalTarget) return undefined;

  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  for (const line of lines.slice(1)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(entry)) return undefined;
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      name = truncate(normalizeWhitespace(entry.name), limits.maxPreviewChars);
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    messageCount += 1;
    if (!firstMessage && entry.message.role === "user") {
      firstMessage = truncate(extractText(entry.message.content), limits.maxPreviewChars);
    }
  }

  const createdAt = validDate(header.timestamp) ?? stat.birthtime.toISOString();
  return {
    conversationId: header.id,
    ...(name ? { name } : {}),
    firstMessage,
    createdAt,
    modifiedAt: stat.mtime.toISOString(),
    messageCount,
  };
}

function defaultSessionDir(target: string, agentDir?: string): string {
  const root = resolve(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const safePath = `--${resolve(target).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(root, "sessions", safePath);
}

function effectiveEnvironmentValue(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): string | undefined {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  return process.env[key];
}

function resolveConfiguredPath(value: string, target: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith(`~${sep}`) ? join(homedir(), value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(target, expanded));
}

function containedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function conversationMatches(conversation: AgentConversation, query: string): boolean {
  return conversation.name?.toLocaleLowerCase().includes(query) === true ||
    conversation.firstMessage.toLocaleLowerCase().includes(query);
}

function normalizeQuery(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\0")) throw new Error("query must be text without NUL bytes");
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  if (normalized.length > maxChars) throw new Error(`query cannot exceed ${maxChars} characters`);
  return normalized;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return normalizeWhitespace(content);
  if (!Array.isArray(content)) return "";
  return normalizeWhitespace(
    content
      .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(" "),
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/.test(value);
}

function validateName(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${field} must be non-empty text without NUL bytes`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
