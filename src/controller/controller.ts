import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { resolveControllerConfig } from "./config.js";
import { attachStrictJsonlReader, serializeJsonl } from "./jsonl.js";
import type {
  AgentSessionControllerConfig,
  AgentSessionSnapshot,
  ChildDialogRequest,
  ChildUiEvent,
  ChildUiEventListener,
  ChildUiRequest,
  DialogCloseReason,
  PromptOptions,
  ResolvedControllerConfig,
  RpcRecord,
  RpcResponse,
  SpawnChild,
  TurnOutcome,
  StateChangedListener,
  TurnSettledListener,
  TurnSnapshot,
  UsageSnapshot,
} from "./types.js";

interface PendingRequest {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface MutableTurn extends TurnSnapshot {
  sawAssistant: boolean;
  interruptedRequested: boolean;
  resolve: (turn: TurnSnapshot) => void;
  completion: Promise<TurnSnapshot>;
}

interface PendingDialog {
  request: ChildDialogRequest;
  timer: NodeJS.Timeout;
}

const MAX_DIALOG_OPTIONS = 200;
const MAX_WIDGET_LINES = 200;
const INHERITED_ENV_DENY = [
  /^PI_SESSION_/,
  /^PI_(?:MODEL|PROVIDER|REASONING_LEVEL)$/,
  /^PI_AGENT_SESSIONS_CONFIG$/,
  /^PI_AGENT_SESSION_DEPTH$/,
  /^PI_AWARENESS/,
  /^IS_MOUNTS$/,
  /^IS_MAP/,
  /^IS_AWARENESS/,
  /^IS_CHANGE/,
  /^IS_CAPTURE/,
  /^IDEASPACES_CHANGE/,
];

export class RpcCommandError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcCommandError";
  }
}

export class PersistentRpcController {
  readonly runId = randomUUID();
  readonly config: ResolvedControllerConfig;

  private child: ReturnType<typeof spawn> | undefined;
  private status: AgentSessionSnapshot["status"] = "starting";
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private usage: UsageSnapshot | undefined;
  private stderr = "";
  private protocolError: string | undefined;
  private requestSequence = 0;
  private operationSequence = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private activeTools = new Map<string, string>();
  private dialogs = new Map<string, PendingDialog>();
  private events: RpcRecord[] = [];
  private turns: MutableTurn[] = [];
  private activeTurn: MutableTurn | undefined;
  private turnSettledListeners = new Set<TurnSettledListener>();
  private uiEventListeners = new Set<ChildUiEventListener>();
  private stateChangedListeners = new Set<StateChangedListener>();
  private stopReading: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  private constructor(
    config: ResolvedControllerConfig,
    private readonly spawnImpl: SpawnChild,
  ) {
    this.config = config;
  }

  static async start(
    input: AgentSessionControllerConfig,
    dependencies: { spawn?: SpawnChild } = {},
  ): Promise<PersistentRpcController> {
    const controller = new PersistentRpcController(resolveControllerConfig(input), dependencies.spawn ?? spawn);
    try {
      await controller.launch();
      return controller;
    } catch (error) {
      await controller.close().catch(() => undefined);
      throw error;
    }
  }

  snapshot(): AgentSessionSnapshot {
    return {
      runId: this.runId,
      pid: this.child?.pid,
      cwd: this.config.target,
      status: this.status,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      activeTools: [...this.activeTools].map(([toolCallId, toolName]) => ({ toolCallId, toolName })),
      outstandingRequestIds: [...this.pendingRequests.keys()],
      outstandingDialogs: [...this.dialogs.values()].map(({ request }) => ({
        id: request.id,
        method: request.method,
        title: request.title,
        timeoutMs: request.timeoutMs,
      })),
      recentEvents: this.events.map((event) => structuredClone(event)),
      turns: this.turns.map(stripTurnInternals),
      usage: this.usage === undefined ? undefined : { ...this.usage },
      stderr: this.stderr,
      protocolError: this.protocolError,
    };
  }

  onTurnSettled(listener: TurnSettledListener): () => void {
    this.turnSettledListeners.add(listener);
    return () => this.turnSettledListeners.delete(listener);
  }

  onUiEvent(listener: ChildUiEventListener): () => void {
    this.uiEventListeners.add(listener);
    return () => this.uiEventListeners.delete(listener);
  }

  onStateChanged(listener: StateChangedListener): () => void {
    this.stateChangedListeners.add(listener);
    return () => this.stateChangedListeners.delete(listener);
  }

  async prompt(message: string, options: PromptOptions = {}): Promise<string> {
    this.requireUsable();
    validateMessage(message);
    if (this.activeTurn && (this.activeTurn.status === "pending" || this.activeTurn.status === "running")) {
      throw new Error("A turn is already running; use steer or followUp");
    }
    const turn = this.createTurn();
    this.activeTurn = turn;
    this.status = "running";
    this.notifyStateChanged();
    try {
      const response = await this.sendRpc({
        type: "prompt",
        message,
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      });
      if (!response.success) {
        this.finishTurn(turn, "rejected", response.error ?? "Prompt rejected");
        throw new RpcCommandError("prompt", response.error ?? "Prompt rejected");
      }
      if (!isTurnOutcome(turn.status)) turn.status = "running";
      return turn.operationId;
    } catch (error) {
      if (turn.status === "pending" || turn.status === "running") {
        this.finishTurn(turn, "failed", errorMessage(error));
      }
      throw error;
    }
  }

  async promptAndWait(message: string, options: PromptOptions = {}): Promise<TurnSnapshot> {
    const operationId = await this.prompt(message, options);
    return this.waitForTurn(operationId);
  }

  async steer(message: string): Promise<void> {
    this.requireActiveTurn("steer");
    validateMessage(message);
    await this.requireSuccess(await this.sendRpc({ type: "steer", message }));
  }

  async followUp(message: string): Promise<void> {
    this.requireActiveTurn("follow_up");
    validateMessage(message);
    await this.requireSuccess(await this.sendRpc({ type: "follow_up", message }));
  }

  async waitForTurn(operationId: string, timeoutMs = this.config.limits.settlementTimeoutMs): Promise<TurnSnapshot> {
    const turn = this.turns.find((candidate) => candidate.operationId === operationId);
    if (!turn) throw new Error(`Unknown operation: ${operationId}`);
    if (isTurnOutcome(turn.status)) return stripTurnInternals(turn);
    return withTimeout(turn.completion, timeoutMs, `Timed out waiting for operation ${operationId}`);
  }

  async respondToDialog(
    id: string,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): Promise<void> {
    this.requireUsable();
    const pending = this.dialogs.get(id);
    if (!pending) throw new Error(`Unknown or settled dialog: ${id}`);
    validateDialogResponse(pending.request, response);
    this.finishDialog(id, "cancelled" in response ? "cancelled" : "answered", response);
  }

  async interrupt(): Promise<TurnSnapshot | undefined> {
    this.requireUsable(true);
    this.cancelDialogs("interrupt");
    const turn = this.activeTurn;
    if (!turn || isTurnOutcome(turn.status)) return undefined;
    turn.interruptedRequested = true;
    try {
      const clearResponse = await this.sendRpc({ type: "clear_queue" });
      await this.requireSuccess(clearResponse);
    } catch {
      // Abort still has to be attempted when queue clearing fails.
    }
    await this.requireSuccess(await this.sendRpc({ type: "abort" }));
    return this.waitForTurn(turn.operationId);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async launch(): Promise<void> {
    const argv = buildPiArgv(this.config);
    const env = buildChildEnv(process.env, this.config);
    const child = this.spawnImpl(this.config.launch.command, argv, {
      cwd: this.config.target,
      env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ReturnType<typeof spawn>;
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
        this.handleExit(code, signal);
      });
    });
    child.once("error", (error) => this.failProcess(new Error(`Failed to launch Pi: ${error.message}`)));
    child.stdin?.on("error", (error) => {
      if (this.status !== "closing" && this.status !== "closed") {
        this.failProcess(new Error(`Pi stdin failed: ${error.message}`));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => this.appendStderr(chunk));
    if (!child.stdout || !child.stdin) throw new Error("Pi process did not expose RPC pipes");
    this.stopReading = attachStrictJsonlReader(
      child.stdout,
      this.config.limits.maxLineBytes,
      (record) => this.handleRecord(record),
      (error) => this.failProcess(error, true),
    );

    const response = await this.sendRpc({ type: "get_state" }, this.config.limits.startupTimeoutMs);
    await this.requireSuccess(response);
    const state = asObject(response.data, "get_state data");
    if (typeof state.sessionId !== "string" || state.sessionId === "") {
      throw new Error("Pi get_state response is missing sessionId");
    }
    this.sessionId = state.sessionId;
    if (typeof state.sessionFile === "string") this.sessionFile = state.sessionFile;
    this.status = state.isStreaming === true ? "running" : "idle";
    this.notifyStateChanged();
  }

  private async closeInternal(): Promise<void> {
    if (!this.child) {
      this.status = "closed";
      return;
    }
    if (this.status === "closed") return;
    const wasCrashed = this.status === "crashed";
    this.status = "closing";
    this.notifyStateChanged();
    this.cancelDialogs("close");

    if (this.activeTurn && !isTurnOutcome(this.activeTurn.status)) {
      try {
        await withTimeout(this.interrupt(), this.config.limits.closeGraceMs, "Turn did not settle before close");
      } catch {
        this.finishTurn(this.activeTurn, "interrupted", "Controller closed the running turn");
      }
    }

    const child = this.child;
    child.stdin?.end();
    let exited = await this.waitForExit(this.config.limits.closeGraceMs);
    if (!exited && child.pid !== undefined) {
      signalProcessTree(child.pid, "SIGTERM");
      exited = await this.waitForExit(this.config.limits.killGraceMs);
    }
    if (!exited && child.pid !== undefined) {
      signalProcessTree(child.pid, "SIGKILL");
      exited = await this.waitForExit(this.config.limits.killGraceMs);
    }

    this.stopReading?.();
    this.stopReading = undefined;
    const closeError = new Error("Controller closed");
    this.rejectPending(closeError);
    this.activeTools.clear();
    this.turnSettledListeners.clear();
    if (!exited) {
      this.status = "crashed";
      this.notifyStateChanged();
      this.uiEventListeners.clear();
      this.stateChangedListeners.clear();
      throw new Error(`Pi process ${child.pid ?? "unknown"} did not exit after forced termination`);
    }
    this.status = wasCrashed ? "crashed" : "closed";
    this.notifyStateChanged();
    this.uiEventListeners.clear();
    this.stateChangedListeners.clear();
  }

  private createTurn(): MutableTurn {
    let resolveCompletion!: (turn: TurnSnapshot) => void;
    const completion = new Promise<TurnSnapshot>((resolve) => {
      resolveCompletion = resolve;
    });
    const turn: MutableTurn = {
      operationId: `${this.runId}:${++this.operationSequence}`,
      status: "pending",
      startedAt: new Date().toISOString(),
      sawAssistant: false,
      interruptedRequested: false,
      resolve: resolveCompletion,
      completion,
    };
    this.turns.push(turn);
    while (this.turns.length > this.config.limits.maxTurns) this.turns.shift();
    return turn;
  }

  private finishTurn(turn: MutableTurn, outcome: TurnOutcome, error?: string): void {
    if (isTurnOutcome(turn.status)) return;
    turn.status = outcome;
    turn.settledAt = new Date().toISOString();
    if (error) turn.error = error;
    const settled = stripTurnInternals(turn);
    turn.resolve(settled);
    if (this.activeTurn === turn) this.activeTurn = undefined;
    if (this.status !== "closing" && this.status !== "closed" && this.status !== "crashed") this.status = "idle";
    this.notifyStateChanged();
    for (const listener of this.turnSettledListeners) {
      try {
        listener(settled);
      } catch {
        // Observers cannot alter controller settlement.
      }
    }
  }

  private handleRecord(value: unknown): void {
    const record = asRecord(value);
    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }
    this.pushEvent(record);
    this.handleEvent(record);
  }

  private handleResponse(record: RpcRecord): void {
    if (typeof record.id !== "string" || typeof record.command !== "string" || typeof record.success !== "boolean") {
      this.failProcess(new Error("Malformed RPC response"), true);
      return;
    }
    const pending = this.pendingRequests.get(record.id);
    if (!pending) {
      this.failProcess(new Error(`Unexpected RPC response id: ${record.id}`), true);
      return;
    }
    if (record.command !== pending.command) {
      this.failProcess(
        new Error(`RPC response command mismatch for ${record.id}: expected ${pending.command}, got ${record.command}`),
        true,
      );
      return;
    }
    this.pendingRequests.delete(record.id);
    clearTimeout(pending.timer);
    pending.resolve(record as unknown as RpcResponse);
  }

  private handleEvent(record: RpcRecord): void {
    switch (record.type) {
      case "agent_start":
      case "turn_start":
      case "auto_retry_start":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
        if (this.status !== "closing") {
          this.status = "running";
          this.notifyStateChanged();
        }
        break;
      case "message_update":
        this.updateUsage(record.usage);
        break;
      case "message_end":
        this.captureAssistant(record.message);
        break;
      case "tool_execution_start":
        if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
          this.activeTools.set(record.toolCallId, record.toolName);
          this.notifyStateChanged();
        }
        break;
      case "tool_execution_end":
        if (typeof record.toolCallId === "string") {
          this.activeTools.delete(record.toolCallId);
          this.notifyStateChanged();
        }
        break;
      case "extension_ui_request":
        this.captureUiRequest(record);
        break;
      case "agent_settled":
        this.settleActiveTurn();
        break;
      default:
        break;
    }
  }

  private captureAssistant(value: unknown): void {
    const turn = this.activeTurn;
    if (!turn || isTurnOutcome(turn.status)) return;
    const message = asObjectOrUndefined(value);
    if (!message || message.role !== "assistant") return;
    turn.sawAssistant = true;
    turn.reply = truncate(extractAssistantText(message.content), this.config.limits.maxReplyChars);
    if (typeof message.stopReason === "string") turn.stopReason = message.stopReason;
    this.updateUsage(message.usage);
  }

  private captureUiRequest(record: RpcRecord): void {
    try {
      const request = parseUiRequest(record, this.config.limits.dialogTimeoutMs);
      if (request.method === "unsupported") {
        this.emitUiEvent({ type: "request", request });
        return;
      }
      if (isDialogRequest(request)) {
        if (this.dialogs.has(request.id)) throw new Error(`Duplicate extension UI request id: ${request.id}`);
        if (this.dialogs.size >= this.config.limits.maxDialogs) {
          throw new Error(`Outstanding dialog limit reached (${this.config.limits.maxDialogs})`);
        }
        const timer = setTimeout(() => this.finishDialog(request.id, "timeout", { cancelled: true }), request.timeoutMs);
        this.dialogs.set(request.id, { request, timer });
        if (this.status !== "closing") this.status = "waiting_for_input";
      }
      this.emitUiEvent({ type: "request", request });
      this.notifyStateChanged();
    } catch (error) {
      this.failProcess(new Error(`Malformed extension UI request: ${errorMessage(error)}`), true);
    }
  }

  private finishDialog(
    id: string,
    reason: DialogCloseReason,
    response?: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): void {
    const pending = this.dialogs.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (response) this.sendRaw({ type: "extension_ui_response", id, ...response });
    this.dialogs.delete(id);
    if (this.status !== "closing" && this.status !== "closed" && this.status !== "crashed") {
      this.status = this.dialogs.size > 0 ? "waiting_for_input" : this.activeTurn ? "running" : "idle";
    }
    this.emitUiEvent({ type: "dialog_closed", id, method: pending.request.method, reason });
    this.notifyStateChanged();
  }

  private cancelDialogs(reason: Exclude<DialogCloseReason, "answered" | "cancelled">): void {
    for (const id of [...this.dialogs.keys()]) {
      try {
        this.finishDialog(id, reason, { cancelled: true });
      } catch {
        const pending = this.dialogs.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.dialogs.delete(id);
          this.emitUiEvent({ type: "dialog_closed", id, method: pending.request.method, reason });
        }
      }
    }
  }

  private emitUiEvent(event: ChildUiEvent): void {
    for (const listener of this.uiEventListeners) {
      try {
        listener(structuredClone(event));
      } catch {
        // UI observers cannot alter controller lifecycle.
      }
    }
  }

  private notifyStateChanged(): void {
    for (const listener of this.stateChangedListeners) {
      try {
        listener();
      } catch {
        // State observers cannot alter controller lifecycle.
      }
    }
  }

  private settleActiveTurn(): void {
    const turn = this.activeTurn;
    if (!turn || isTurnOutcome(turn.status)) return;
    this.activeTools.clear();
    if (turn.interruptedRequested || turn.stopReason === "aborted") {
      this.finishTurn(turn, "interrupted");
    } else if (!turn.sawAssistant) {
      this.finishTurn(turn, "failed", "Pi settled without a new assistant reply");
    } else if (turn.stopReason === "error") {
      this.finishTurn(turn, "failed", turn.reply || "Pi returned an error stop reason");
    } else {
      this.finishTurn(turn, "completed");
    }
  }

  private pushEvent(record: RpcRecord): void {
    this.events.push(record);
    while (this.events.length > this.config.limits.maxRecentEvents) this.events.shift();
  }

  private updateUsage(value: unknown): void {
    const usage = asObjectOrUndefined(value);
    if (!usage) return;
    const next: UsageSnapshot = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      if (typeof usage[key] === "number" && Number.isFinite(usage[key])) next[key] = usage[key];
    }
    if (typeof usage.cost === "number" || (usage.cost !== null && typeof usage.cost === "object")) next.cost = usage.cost as UsageSnapshot["cost"];
    this.usage = next;
  }

  private appendStderr(chunk: Buffer | string): void {
    this.stderr = truncateTail(this.stderr + chunk.toString(), this.config.limits.maxStderrBytes);
  }

  private async sendRpc(command: RpcRecord, timeoutMs = this.config.limits.requestTimeoutMs): Promise<RpcResponse> {
    const id = `req_${++this.requestSequence}`;
    const fullCommand = { ...command, id };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${command.type} response`));
      }, timeoutMs);
      this.pendingRequests.set(id, { command: command.type, resolve, reject, timer });
      try {
        this.sendRaw(fullCommand);
      } catch (error) {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private sendRaw(command: RpcRecord): void {
    const stdin = this.child?.stdin as Writable | null | undefined;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Pi RPC stdin is not writable");
    stdin.write(serializeJsonl(command, this.config.limits.maxLineBytes));
  }

  private async requireSuccess(response: RpcResponse): Promise<void> {
    if (!response.success) throw new RpcCommandError(response.command, response.error ?? `${response.command} failed`);
  }

  private requireUsable(allowClosing = false): void {
    if (!this.child) throw new Error("Controller has not started");
    if (this.status === "crashed") throw new Error(this.protocolError ?? "Pi process crashed");
    if (this.status === "closed" || (!allowClosing && this.status === "closing")) {
      throw new Error("Controller is closed");
    }
  }

  private requireActiveTurn(command: string): MutableTurn {
    this.requireUsable();
    const turn = this.activeTurn;
    if (!turn || isTurnOutcome(turn.status)) throw new Error(`${command} requires a running turn`);
    return turn;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(`Pi process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
    this.rejectPending(error);
    if (this.status === "closing" || this.status === "closed") return;
    this.failProcess(error);
  }

  private failProcess(error: Error, protocol = false): void {
    if (this.status === "closed" || this.status === "crashed") return;
    if (protocol) this.protocolError = error.message;
    this.status = "crashed";
    this.rejectPending(error);
    this.activeTools.clear();
    for (const [id, pending] of this.dialogs) {
      clearTimeout(pending.timer);
      this.emitUiEvent({ type: "dialog_closed", id, method: pending.request.method, reason: "process_exit" });
    }
    this.dialogs.clear();
    this.notifyStateChanged();
    if (this.activeTurn && !isTurnOutcome(this.activeTurn.status)) this.finishTurn(this.activeTurn, "failed", error.message);
    if (this.child?.pid !== undefined) signalProcessTree(this.child.pid, "SIGKILL");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return true;
    if (!this.exited) return true;
    try {
      await withTimeout(this.exited, timeoutMs, "Process exit timeout");
      return true;
    } catch {
      return false;
    }
  }
}

export function buildPiArgv(config: ResolvedControllerConfig): string[] {
  const argv = [...config.launch.argvPrefix, "--mode", "rpc"];
  if (config.model) argv.push("--model", config.model);
  if (config.thinking) argv.push("--thinking", config.thinking);
  if (config.trust.mode === "explicit") argv.push("--approve");
  if (config.extensionPaths !== undefined) {
    argv.push("--no-extensions");
    for (const path of config.extensionPaths) argv.push("--extension", path);
  }
  if (config.skillPaths !== undefined) {
    for (const path of config.skillPaths) argv.push("--skill", path);
  }
  return argv;
}

export function buildChildEnv(
  inherited: NodeJS.ProcessEnv,
  config: ResolvedControllerConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (INHERITED_ENV_DENY.some((pattern) => pattern.test(key))) continue;
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  env.PI_AGENT_SESSION_DEPTH = "1";
  if (config.packageDir) env.PI_PACKAGE_DIR = config.packageDir;
  if (config.agentDir) env.PI_CODING_AGENT_DIR = config.agentDir;
  return env;
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true });
      else process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      // Last-resort direct signal if process-group signaling is unavailable.
      try {
        process.kill(pid, signal);
      } catch {
        // The process already exited or cannot be signalled by this host.
      }
    }
  }
}

function parseUiRequest(record: RpcRecord, defaultDialogTimeoutMs: number): ChildUiRequest {
  const id = requireRecordString(record, "id");
  const method = requireRecordString(record, "method");
  const title = () => requireRecordString(record, "title");
  const timeoutMs = () => {
    if (record.timeout === undefined) return defaultDialogTimeoutMs;
    if (!Number.isSafeInteger(record.timeout) || (record.timeout as number) <= 0) {
      throw new Error("timeout must be a positive integer");
    }
    return Math.min(record.timeout as number, defaultDialogTimeoutMs);
  };

  switch (method) {
    case "select": {
      if (!Array.isArray(record.options) || record.options.length === 0 || record.options.length > MAX_DIALOG_OPTIONS) {
        throw new Error(`options must contain between 1 and ${MAX_DIALOG_OPTIONS} strings`);
      }
      if (record.options.some((option) => typeof option !== "string")) throw new Error("options must contain only strings");
      return { id, method, title: title(), options: [...record.options] as string[], timeoutMs: timeoutMs() };
    }
    case "confirm":
      return { id, method, title: title(), message: requireRecordString(record, "message", true), timeoutMs: timeoutMs() };
    case "input":
      return {
        id,
        method,
        title: title(),
        placeholder: optionalRecordString(record, "placeholder"),
        timeoutMs: timeoutMs(),
      };
    case "editor":
      return {
        id,
        method,
        title: title(),
        prefill: optionalRecordString(record, "prefill"),
        timeoutMs: defaultDialogTimeoutMs,
      };
    case "notify": {
      const notifyType = record.notifyType ?? "info";
      if (notifyType !== "info" && notifyType !== "warning" && notifyType !== "error") {
        throw new Error("notifyType must be info, warning, or error");
      }
      return { id, method, message: requireRecordString(record, "message", true), notifyType };
    }
    case "setStatus":
      return {
        id,
        method,
        statusKey: requireRecordString(record, "statusKey"),
        statusText: optionalRecordString(record, "statusText"),
      };
    case "setWidget": {
      if (
        record.widgetLines !== undefined &&
        (!Array.isArray(record.widgetLines) ||
          record.widgetLines.length > MAX_WIDGET_LINES ||
          record.widgetLines.some((line) => typeof line !== "string"))
      ) {
        throw new Error(`widgetLines must contain at most ${MAX_WIDGET_LINES} strings`);
      }
      const placement = record.widgetPlacement ?? "aboveEditor";
      if (placement !== "aboveEditor" && placement !== "belowEditor") {
        throw new Error("widgetPlacement must be aboveEditor or belowEditor");
      }
      return {
        id,
        method,
        widgetKey: requireRecordString(record, "widgetKey"),
        widgetLines: record.widgetLines === undefined ? undefined : [...record.widgetLines] as string[],
        widgetPlacement: placement,
      };
    }
    case "setTitle":
      return { id, method, title: title() };
    case "set_editor_text":
      return { id, method, text: requireRecordString(record, "text", true) };
    default:
      return { id, method: "unsupported", requestedMethod: method };
  }
}

function isDialogRequest(request: ChildUiRequest): request is ChildDialogRequest {
  return request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor";
}

function validateDialogResponse(
  request: ChildDialogRequest,
  response: { value: string } | { confirmed: boolean } | { cancelled: true },
): void {
  if ("cancelled" in response) return;
  if (request.method === "confirm") {
    if (!("confirmed" in response) || typeof response.confirmed !== "boolean") {
      throw new Error(`Dialog ${request.id} requires a confirmation response`);
    }
    return;
  }
  if (!("value" in response) || typeof response.value !== "string") {
    throw new Error(`Dialog ${request.id} requires a string response`);
  }
  if (request.method === "select" && !request.options.includes(response.value)) {
    throw new Error(`Dialog ${request.id} response is not one of its options`);
  }
}

function requireRecordString(record: RpcRecord, field: string, allowEmpty = false): string {
  const value = record[field];
  if (typeof value !== "string" || (!allowEmpty && value === "")) throw new Error(`${field} must be a string${allowEmpty ? "" : " and cannot be empty"}`);
  return value;
}

function optionalRecordString(record: RpcRecord, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string when present`);
  return value;
}

function asRecord(value: unknown): RpcRecord {
  const object = asObject(value, "RPC record");
  if (typeof object.type !== "string" || object.type === "") throw new Error("RPC record is missing type");
  return object as RpcRecord;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function asObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      const object = asObjectOrUndefined(part);
      return object?.type === "text" && typeof object.text === "string";
    })
    .map((part) => part.text)
    .join("");
}

function stripTurnInternals(turn: MutableTurn): TurnSnapshot {
  return {
    operationId: turn.operationId,
    status: turn.status,
    startedAt: turn.startedAt,
    settledAt: turn.settledAt,
    reply: turn.reply,
    stopReason: turn.stopReason,
    error: turn.error,
  };
}

function isTurnOutcome(status: TurnSnapshot["status"]): status is TurnOutcome {
  return status === "rejected" || status === "completed" || status === "failed" || status === "interrupted";
}

function validateMessage(message: string): void {
  if (typeof message !== "string" || message.trim() === "" || message.includes("\0")) {
    throw new Error("message must be a non-empty string without NUL bytes");
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function truncateTail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs === 0) throw new Error(message);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
