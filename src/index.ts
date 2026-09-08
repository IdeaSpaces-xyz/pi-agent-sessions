import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./extension/index.js";

export default function agentSessionsExtension(pi: ExtensionAPI): void {
  register(pi);
}

export { OwnedAgentSessions } from "./sessions/owned-sessions.js";
export {
  DEFAULT_CONVERSATION_LIMITS,
  listAgentConversations,
  resolveAgentSessionDir,
  validateConversationLimits,
} from "./conversations/catalog.js";
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
  ChildDialogRequest,
  ChildUiEvent,
  ChildUiEventListener,
  ChildUiRequest,
  ControllerLimits,
  ControllerRuntime,
  DialogCloseReason,
  DialogMethod,
  DialogSnapshot,
  PiExecutableConfig,
  ProcessStatus,
  PromptOptions,
  ResolvedControllerConfig,
  ResolvedLaunch,
  ResolvedResumeSession,
  ResumeSessionConfig,
  RpcRecord,
  RpcResponse,
  StateChangedListener,
  TrustPolicy,
  TurnOutcome,
  TurnSnapshot,
  TurnStatus,
  UsageSnapshot,
} from "./controller/types.js";
export type {
  AgentConversation,
  AgentConversationCatalog,
  ConversationCatalogLimits,
  ConversationCatalogOptions,
} from "./conversations/types.js";
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
  OwnedUiEvent,
  OwnedSessionsStatus,
  ListConversationsInput,
  ListConversationsResult,
  SendSessionInput,
  ResumeSessionInput,
  SessionController,
  SessionControllerFactory,
  SessionOperationResult,
  SessionPointer,
  StartSessionInput,
  StatusOptions,
} from "./sessions/types.js";
export type { AgentSessionToolInput } from "./extension/index.js";
export type { ParsedExtensionConfig } from "./extension/config.js";
