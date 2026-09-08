import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentDiscoveryOptions, AgentRoster, AgentRosterEntry } from "./types.js";

export const DEFAULT_MAX_AGENTS = 200;
export const HARD_MAX_AGENTS = 1_000;
export const DEFAULT_MAX_SCANNED_ENTRIES = 2_000;
export const HARD_MAX_SCANNED_ENTRIES = 10_000;

export async function discoverAgentRoster(
  collectionRoot: string,
  options: AgentDiscoveryOptions = {},
): Promise<AgentRoster> {
  const root = await resolveCollectionRoot(collectionRoot);
  const maxAgents = boundedInteger(options.maxAgents, DEFAULT_MAX_AGENTS, HARD_MAX_AGENTS, "maxAgents");
  const maxScannedEntries = boundedInteger(
    options.maxScannedEntries,
    DEFAULT_MAX_SCANNED_ENTRIES,
    HARD_MAX_SCANNED_ENTRIES,
    "maxScannedEntries",
  );
  const candidates: AgentRosterEntry[] = [];
  let scannedEntries = 0;
  let scanTruncated = false;
  const directory = await opendir(root);
  try {
    for await (const entry of directory) {
      if (scannedEntries >= maxScannedEntries) {
        scanTruncated = true;
        break;
      }
      scannedEntries += 1;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = await validateAgentAt(root, entry.name).catch(() => undefined);
      if (candidate) candidates.push(candidate);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  candidates.sort((left, right) => compareNames(left.name, right.name));
  return {
    root,
    agents: candidates.slice(0, maxAgents),
    scannedEntries,
    truncated: scanTruncated || candidates.length > maxAgents,
  };
}

export async function revalidateAgentTarget(
  collectionRoot: string,
  entry: AgentRosterEntry,
): Promise<AgentRosterEntry> {
  const root = await resolveCollectionRoot(collectionRoot);
  const current = await validateAgentAt(root, entry.name);
  if (current.path !== entry.path) {
    throw new Error(`Agent target changed after discovery: ${entry.name}`);
  }
  return current;
}

export async function resolveCollectionRoot(collectionRoot: string): Promise<string> {
  validatePath(collectionRoot, "collectionRoot");
  if (!isAbsolute(collectionRoot)) throw new Error("collectionRoot must be an absolute path");
  let root: string;
  try {
    root = await realpath(resolve(collectionRoot));
  } catch {
    throw new Error(`collectionRoot does not exist: ${collectionRoot}`);
  }
  const stat = await lstat(root);
  if (!stat.isDirectory()) throw new Error(`collectionRoot must be a directory: ${root}`);
  return root;
}

async function validateAgentAt(root: string, name: string): Promise<AgentRosterEntry> {
  validateAgentName(name);
  const lexicalTarget = join(root, name);
  const targetStat = await lstat(lexicalTarget);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`Agent target is not a direct directory: ${name}`);
  }

  const target = await realpath(lexicalTarget);
  if (!isImmediateChild(root, target) || target !== lexicalTarget) {
    throw new Error(`Agent target escapes its collection: ${name}`);
  }

  const agentDir = join(target, "_agent");
  const agentDirStat = await lstat(agentDir);
  if (!agentDirStat.isDirectory() || agentDirStat.isSymbolicLink()) {
    throw new Error(`Agent is missing a local _agent directory: ${name}`);
  }

  const foundation = join(agentDir, "foundation.md");
  const foundationStat = await lstat(foundation);
  if (!foundationStat.isFile() || foundationStat.isSymbolicLink()) {
    throw new Error(`Agent is missing _agent/foundation.md: ${name}`);
  }
  const canonicalFoundation = await realpath(foundation);
  if (!isWithin(target, canonicalFoundation)) {
    throw new Error(`Agent foundation escapes its folder: ${name}`);
  }

  return { name, path: target };
}

function validateAgentName(name: string): void {
  if (
    typeof name !== "string" ||
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error("Agent name must be one immediate child name");
  }
}

function validatePath(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty path without NUL bytes`);
  }
}

function isImmediateChild(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) && !path.includes(sep);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
