import type { ChildProcess } from "node:child_process";

export type ProcessStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_for_input"
  | "closing"
  | "closed"
  | "crashed";

export type TurnOutcome = "rejected" | "completed" | "failed" | "interrupted";
export type TurnStatus = "pending" | "running" | TurnOutcome;
export type TrustPolicy = { mode: "saved" } | { mode: "explicit" };

export interface PiExecutableConfig {
  /** Executable path or bare command name. Bare names are resolved through PATH before spawn. */
  command: string;
  /** Arguments placed before Pi's RPC arguments, for example a Node CLI script. */
  argvPrefix?: readonly string[];
}

export interface ControllerLimits {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  settlementTimeoutMs: number;
  dialogTimeoutMs: number;
  closeGraceMs: number;
  killGraceMs: number;
  maxLineBytes: number;
  maxRecentEvents: number;
  maxTurns: number;
  maxStderrBytes: number;
  maxReplyChars: number;
  maxDialogs: number;
  maxChildren: number;
}

export interface AgentSessionControllerConfig {
  target: string;
  trust: TrustPolicy;
  executable?: PiExecutableConfig;
  packageDir?: string;
  agentDir?: string;
  extensionPaths?: readonly string[];
  skillPaths?: readonly string[];
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  env?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<ControllerLimits>;
}

export interface ResolvedLaunch {
  command: string;
  argvPrefix: string[];
  source: "explicit" | "current-cli" | "packaged";
}

export interface ResolvedControllerConfig
  extends Omit<AgentSessionControllerConfig, "target" | "executable" | "limits"> {
  target: string;
  launch: ResolvedLaunch;
  limits: ControllerLimits;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type RpcRecord = Record<string, unknown> & { type: string };

export interface UsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number | Record<string, unknown>;
}

export interface TurnSnapshot {
  operationId: string;
  status: TurnStatus;
  startedAt: string;
  settledAt?: string;
  reply?: string;
  stopReason?: string;
  error?: string;
}

export type DialogMethod = "select" | "confirm" | "input" | "editor";
export type DialogCloseReason = "answered" | "cancelled" | "timeout" | "interrupt" | "close" | "process_exit";

interface ChildDialogBase {
  id: string;
  title: string;
  timeoutMs: number;
}

export type ChildDialogRequest =
  | (ChildDialogBase & { method: "select"; options: string[] })
  | (ChildDialogBase & { method: "confirm"; message: string })
  | (ChildDialogBase & { method: "input"; placeholder?: string })
  | (ChildDialogBase & { method: "editor"; prefill?: string });

export type ChildUiRequest =
  | ChildDialogRequest
  | { id: string; method: "notify"; message: string; notifyType: "info" | "warning" | "error" }
  | { id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | {
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement: "aboveEditor" | "belowEditor";
    }
  | { id: string; method: "setTitle"; title: string }
  | { id: string; method: "set_editor_text"; text: string }
  | { id: string; method: "unsupported"; requestedMethod: string };

export type ChildUiEvent =
  | { type: "request"; request: ChildUiRequest }
  | { type: "dialog_closed"; id: string; method: DialogMethod; reason: DialogCloseReason };

export interface DialogSnapshot {
  id: string;
  method: DialogMethod;
  title: string;
  timeoutMs: number;
}

export interface AgentSessionSnapshot {
  runId: string;
  pid?: number;
  cwd: string;
  status: ProcessStatus;
  sessionId?: string;
  sessionFile?: string;
  activeTools: Array<{ toolCallId: string; toolName: string }>;
  outstandingRequestIds: string[];
  outstandingDialogs: DialogSnapshot[];
  recentEvents: RpcRecord[];
  turns: TurnSnapshot[];
  usage?: UsageSnapshot;
  stderr: string;
  protocolError?: string;
}

export interface PromptOptions {
  streamingBehavior?: "steer" | "followUp";
}

export type TurnSettledListener = (turn: TurnSnapshot) => void;
export type ChildUiEventListener = (event: ChildUiEvent) => void;
export type StateChangedListener = () => void;

export interface ControllerRuntime {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
}

export type SpawnChild = (
  command: string,
  argv: readonly string[],
  options: Parameters<typeof import("node:child_process").spawn>[2],
) => ChildProcess;
