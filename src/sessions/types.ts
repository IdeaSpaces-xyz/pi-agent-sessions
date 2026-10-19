import type {
  AgentSessionControllerConfig,
  AgentSessionSnapshot,
  ChildUiEvent,
  PromptOptions,
  TurnSnapshot,
} from "../controller/types.js";
import type { AgentRoster, AgentRosterEntry } from "../discovery/types.js";
import type { AgentConversationCatalog, ConversationCatalogLimits } from "../conversations/types.js";

export interface SessionController {
  readonly runId: string;
  snapshot(): AgentSessionSnapshot;
  prompt(message: string, options?: PromptOptions): Promise<string>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  waitForTurn(operationId: string, timeoutMs?: number): Promise<TurnSnapshot>;
  onTurnSettled?(listener: (turn: TurnSnapshot) => void): () => void;
  onUiEvent?(listener: (event: ChildUiEvent) => void): () => void;
  onStateChanged?(listener: () => void): () => void;
  respondToDialog?(
    id: string,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): Promise<void>;
  interrupt(): Promise<TurnSnapshot | undefined>;
  close(): Promise<void>;
}

export type SessionControllerFactory = (
  config: AgentSessionControllerConfig,
) => Promise<SessionController>;

export interface AgentReply {
  agent: string;
  runId: string;
  operationId: string;
  outcome: TurnSnapshot["status"];
  reply?: string;
  error?: string;
  settledAt?: string;
  branchEpoch: number;
}

export interface SessionPointer {
  event: "started" | "closed";
  agent: string;
  runId: string;
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  at: string;
}

export interface OwnedRunSnapshot {
  agent: string;
  branchEpoch: number;
  unreadReplies: number;
  session: AgentSessionSnapshot;
}

export interface OwnedSessionsList {
  roster?: AgentRoster;
  runs: OwnedRunSnapshot[];
  configurationError?: string;
}

export interface OwnedSessionsStatus {
  runs: OwnedRunSnapshot[];
  unread: AgentReply[];
}

export interface SessionOperationResult {
  run: OwnedRunSnapshot;
  operation?: TurnSnapshot;
  queuedToOperationId?: string;
}

export interface OwnedAgentSessionsConfig {
  collectionRoot?: string;
  approveProjectResources?: boolean;
  depth?: number;
  discovery?: {
    maxAgents?: number;
    maxScannedEntries?: number;
  };
  conversations?: Partial<ConversationCatalogLimits>;
  controller?: Omit<AgentSessionControllerConfig, "target" | "trust" | "model" | "thinking" | "sessionName" | "resumeSession">;
}

export interface OwnedUiEvent {
  agent: string;
  runId: string;
  event: ChildUiEvent;
}

export interface OwnedAgentSessionsHooks {
  deliver(reply: AgentReply): void;
  replyHeld?(reply: AgentReply): void;
  pointer?(pointer: SessionPointer): void;
  uiEvent?(event: OwnedUiEvent): void;
  stateChanged?(): void;
}

import type { CliControllerConfig } from "../controller/cli-controller.js";

export interface ParentPiResources {
  extensionPaths: string[];
  skillPaths: string[];
}

export interface OwnedAgentSessionsDependencies {
  createController?: SessionControllerFactory;
  createClaudeController?: (config: CliControllerConfig) => Promise<SessionController>;
  /** Derived from this parent's active trusted resources, never child discovery. */
  resolveCliResources?: () => ParentPiResources;
  now?: () => Date;
}

export interface StartSessionInput {
  agent: string;
  message: string;
  runtime?: "pi" | "claude";
  topic?: string;
  model?: string;
  thinking?: AgentSessionControllerConfig["thinking"];
  effort?: CliControllerConfig["effort"];
  readOnly?: boolean;
  permissionMode?: string;
  /** Optional turn ceiling in ms; 0 or unset means no timeout. CLI kills process tree; resident Pi requests abort. */
  timeoutMs?: number;
}

export interface ListConversationsInput {
  agent: string;
  query?: string;
}

export interface ResumeSessionInput {
  agent: string;
  conversationId: string;
  message: string;
  runtime?: "pi" | "claude";
  model?: string;
  thinking?: AgentSessionControllerConfig["thinking"];
  effort?: CliControllerConfig["effort"];
  readOnly?: boolean;
  permissionMode?: string;
  /** Optional turn ceiling in ms; 0 or unset means no timeout. CLI kills process tree; resident Pi requests abort. */
  timeoutMs?: number;
}

export type ListConversationsResult = AgentConversationCatalog;

export interface SendSessionInput {
  runId: string;
  message: string;
  busyMode?: "steer" | "followUp";
  /** Optional turn ceiling in ms for a new turn; not available when steering a busy run. */
  timeoutMs?: number;
}

export interface StatusOptions {
  runId?: string;
  includeEvents?: boolean;
  consumeUnread?: boolean;
}

export interface ManagedAgentEntry extends AgentRosterEntry {
  discoveredFrom: string;
}
