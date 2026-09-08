import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function agentSessionsExtension(pi: ExtensionAPI): Promise<void> {
  const { default: register } = await import("./extension/index.js");
  register(pi);
}

export { OwnedAgentSessions } from "./sessions/owned-sessions.js";
export {
  discoverAgentRoster,
  revalidateAgentTarget,
  resolveCollectionRoot,
  DEFAULT_MAX_AGENTS,
  DEFAULT_MAX_SCANNED_ENTRIES,
  HARD_MAX_AGENTS,
  HARD_MAX_SCANNED_ENTRIES,
} from "./discovery/discovery.js";
export {
  APPROVE_FLAG,
  COLLECTION_FLAG,
  DEPTH_ENV,
  HOST_CONFIG_ENV,
  parseDepth,
  resolveExtensionConfig,
} from "./extension/config.js";
export {
  PersistentRpcController,
  RpcCommandError,
  buildChildEnv,
  buildPiArgv,
} from "./controller/controller.js";
export { DEFAULT_LIMITS, resolveControllerConfig, validateLimits } from "./controller/config.js";
export { resolveExecutable, resolvePiLaunch } from "./controller/executable.js";
export {
  JsonlProtocolError,
  StrictJsonlDecoder,
  attachStrictJsonlReader,
  serializeJsonl,
} from "./controller/jsonl.js";
export type {
  AgentSessionControllerConfig,
  AgentSessionSnapshot,
  ControllerLimits,
  ControllerRuntime,
  DialogSnapshot,
  PiExecutableConfig,
  ProcessStatus,
  PromptOptions,
  ResolvedControllerConfig,
  ResolvedLaunch,
  RpcRecord,
  RpcResponse,
  TrustPolicy,
  TurnOutcome,
  TurnSnapshot,
  TurnStatus,
  UsageSnapshot,
} from "./controller/types.js";
export type {
  AgentDiscoveryOptions,
  AgentRoster,
  AgentRosterEntry,
} from "./discovery/types.js";
export type {
  AgentReply,
  OwnedAgentSessionsConfig,
  OwnedAgentSessionsDependencies,
  OwnedAgentSessionsHooks,
  OwnedRunSnapshot,
  OwnedSessionsList,
  OwnedSessionsStatus,
  SendSessionInput,
  SessionController,
  SessionControllerFactory,
  SessionOperationResult,
  SessionPointer,
  StartSessionInput,
  StatusOptions,
} from "./sessions/types.js";
export type { AgentSessionToolInput } from "./extension/index.js";
export type { ParsedExtensionConfig } from "./extension/config.js";
