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
  closeGraceMs: number;
  killGraceMs: number;
  maxLineBytes: number;
  maxRecentEvents: number;
  maxTurns: number;
  maxStderrBytes: number;
  maxReplyChars: number;
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

export interface DialogSnapshot {
  id: string;
  method: string;
  title?: string;
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
