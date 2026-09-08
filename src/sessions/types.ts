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
  controller?: Omit<AgentSessionControllerConfig, "target" | "trust" | "model" | "thinking" | "sessionName">;
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

export interface OwnedAgentSessionsDependencies {
  createController?: SessionControllerFactory;
  now?: () => Date;
}

export interface StartSessionInput {
  agent: string;
  message: string;
  topic?: string;
  model?: string;
  thinking?: AgentSessionControllerConfig["thinking"];
}

export interface ListConversationsInput {
  agent: string;
  query?: string;
}

export type ListConversationsResult = AgentConversationCatalog;

export interface SendSessionInput {
  runId: string;
  message: string;
  busyMode?: "steer" | "followUp";
}

export interface StatusOptions {
  runId?: string;
  includeEvents?: boolean;
  consumeUnread?: boolean;
}

export interface ManagedAgentEntry extends AgentRosterEntry {
  discoveredFrom: string;
}
