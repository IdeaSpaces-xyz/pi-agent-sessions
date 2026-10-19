import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionSnapshot, ProcessStatus, PromptOptions, TurnSnapshot, TurnSettledListener, StateChangedListener } from "./types.js";
import type { SessionController } from "../sessions/types.js";
import { validateLimits } from "./config.js";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_REPLY_CHARS = 12_000;
const MAX_ERROR_CHARS = 4_000;
const KILL_GRACE_MS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITIES_SCHEMA = "ideaspaces.agent-run.capabilities";
const MAX_CAPABILITIES_CHARS = 64_000;
/** First CLI release with `agent capabilities`; named in the update instruction only. */
const MIN_CAPABLE_CLI = "0.2.17";

export interface CliControllerConfig {
  target: string;
  runtime: "claude" | "pi";
  model?: string;
  /** Name for a new Pi transcript only; never forwarded on subsequent turns. */
  topic?: string;
  thinking?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: string;
  readOnly?: boolean;
  trust?: "saved" | "explicit";
  resumeConversationId?: string;
  /** Already active/trusted paths from the launching Pi parent; never child discovery. */
  extensionPaths?: readonly string[];
  skillPaths?: readonly string[];
  cliPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  limits?: { settlementTimeoutMs?: number; maxLineBytes?: number; maxReplyChars?: number; maxStderrBytes?: number; killGraceMs?: number };
  spawn?: typeof spawn;
}

type TargetIdentity = { root: string; device: number; inode: number; contractDevice: number; contractInode: number };

/** A short-lived CLI process per turn. The parent owns this controller, not a detached live session. */
export class CliAgentController implements SessionController {
  readonly runId = `cli-${randomUUID()}`;
  conversationId: string;
  private readonly identity: TargetIdentity;
  private readonly cliPath: string;
  private readonly spawnImpl: typeof spawn;
  private statusValue: ProcessStatus = "idle";
  /** What the CLI reported the runtime actually ran on the latest turn; never the requested override. */
  private observedModel?: string;
  private child?: ChildProcess;
  private turns: TurnSnapshot[] = [];
  private pending = new Map<string, Promise<TurnSnapshot>>();
  private readonly settled = new Set<TurnSettledListener>();
  private readonly changed = new Set<StateChangedListener>();
  private active?: { stop: (reason: "interrupted" | "closed" | "timeout") => void; done: Promise<TurnSnapshot> };

  constructor(private readonly config: CliControllerConfig) {
    if (config.limits?.settlementTimeoutMs !== undefined) validateLimits({ settlementTimeoutMs: config.limits.settlementTimeoutMs });
    if (config.topic && config.runtime !== "pi") throw new Error("topic names Pi sessions only; Claude naming is not supported.");
    if (config.topic && config.resumeConversationId) throw new Error("topic cannot rename a resumed conversation.");
    if (config.runtime === "claude" && config.permissionMode === "bypassPermissions" && config.readOnly !== false) {
      throw new Error("Claude bypassPermissions requires readOnly:false explicitly.");
    }
    this.identity = targetIdentity(config.target);
    this.conversationId = config.resumeConversationId ?? ""; // first turn belongs to CLI minting
    if (this.conversationId && config.runtime === "claude" && !UUID.test(this.conversationId)) {
      throw new Error("Claude conversation id must be a UUID");
    }
    if (this.conversationId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(this.conversationId)) {
      throw new Error("Invalid conversation id");
    }
    if (config.runtime === "pi" && (!config.extensionPaths?.length || config.extensionPaths.some((path) => !path || path.includes(",")) ||
        config.skillPaths?.some((path) => !path || path.includes(",")))) {
      throw new Error("Active parent Pi resource paths are absent or contain a comma; cannot pass an exact child set through CLI --ext/--skill.");
    }
    this.cliPath = config.cliPath ?? process.env.IS_CLI_PATH?.trim() ?? "ideaspaces";
    this.spawnImpl = config.spawn ?? spawn;
  }

  static async start(config: CliControllerConfig): Promise<CliAgentController> {
    const controller = new CliAgentController(config);
    await controller.verifyCliCapabilities();
    if (config.resumeConversationId) await controller.verifyExistingConversation();
    return controller;
  }

  /** The CLI states what `agent run` guarantees as data; help prose is for people and is never parsed. */
  private async verifyCliCapabilities(): Promise<void> {
    assertTargetUnchanged(this.identity);
    const isScript = /[\\/]/.test(this.cliPath) && /\.(?:[cm]?js)$/.test(this.cliPath);
    const args = ["--json", "agent", "capabilities"];
    const result = await new Promise<{ out: string; code: number; spawnError?: string }>((resolve) => {
      let out = "";
      let child: ChildProcess;
      try {
        child = this.spawnImpl(isScript ? process.execPath : this.cliPath, isScript ? [this.cliPath, ...args] : args,
          { cwd: this.identity.root, shell: false, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch (err) {
        resolve({ out: "", code: 1, spawnError: errorText(err) });
        return;
      }
      const timer = setTimeout(() => signalTree(child, "SIGKILL"), 10_000);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        if (out.length > MAX_CAPABILITIES_CHARS) signalTree(child, "SIGKILL");
      });
      child.once("error", (err) => { clearTimeout(timer); resolve({ out: "", code: 1, spawnError: err.message }); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ out, code: code ?? 1 }); });
    });
    if (result.spawnError) {
      throw new Error(`Could not run the IdeaSpaces CLI (${this.cliPath}): ${result.spawnError}. Install it or set IS_CLI_PATH before launching this POV.`);
    }
    const features = result.code === 0 && result.out.length <= MAX_CAPABILITIES_CHARS ? parseCapabilities(result.out) : undefined;
    if (!features) {
      throw new Error(`The IdeaSpaces CLI (${this.cliPath}) does not report agent-run capabilities; update @ideaspaces/cli to ${MIN_CAPABLE_CLI} or newer before launching this POV.`);
    }
    const missing = requiredFeatures(this.config).filter((feature) => !features.has(feature));
    if (missing.length) {
      throw new Error(`The IdeaSpaces CLI (${this.cliPath}) does not guarantee ${missing.join(", ")} for ${this.config.runtime} launches; update @ideaspaces/cli before launching this POV.`);
    }
  }

  snapshot(): AgentSessionSnapshot {
    return {
      runId: this.runId, pid: this.child?.pid, cwd: this.identity.root,
      status: this.statusValue, runtime: this.config.runtime, model: this.config.model, observedModel: this.observedModel,
      thinking: this.config.thinking, effort: this.config.effort,
      readOnly: this.config.runtime === "claude" ? this.config.readOnly !== false : undefined,
      sessionId: this.conversationId || undefined,
      activeTools: [], outstandingRequestIds: [], outstandingDialogs: [], recentEvents: [],
      turns: this.turns.map((turn) => ({ ...turn })), stderr: "",
    };
  }

  private async verifyExistingConversation(): Promise<void> {
    assertTargetUnchanged(this.identity);
    const args = ["--json", "conversation", "get", "--local", "--runtime", this.config.runtime,
      "--context", this.identity.root, "--conversation", this.conversationId];
    const isScript = /[\\/]/.test(this.cliPath) && /\.(?:[cm]?js)$/.test(this.cliPath);
    const command = isScript ? process.execPath : this.cliPath;
    const argv = isScript ? [this.cliPath, ...args] : args;
    await new Promise<void>((resolve, reject) => {
      let out = "";
      let err = "";
      const child = this.spawnImpl(command, argv, { cwd: this.identity.root, shell: false,
        detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...this.config.env } });
      const timer = setTimeout(() => signalTree(child, "SIGKILL"), 15_000);
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        if (Buffer.byteLength(out) > 4 * 1024 * 1024) signalTree(child, "SIGKILL");
      });
      child.stderr?.on("data", (chunk: string) => { err = (err + chunk).slice(0, 4000); });
      child.once("error", (e) => { err = e.message; });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || Buffer.byteLength(out) > 4 * 1024 * 1024) {
          reject(new Error(err || "Could not verify conversation before resume"));
          return;
        }
        try {
          const detail = JSON.parse(out) as { repo_id?: string; history?: unknown[] };
          if (detail.repo_id !== this.identity.root || !Array.isArray(detail.history) || !detail.history.length) {
            reject(new Error(`No existing ${this.config.runtime} conversation at this POV; refusing to start a new transcript.`));
          } else resolve();
        } catch { reject(new Error("Cannot verify conversation identity before resume")); }
      });
    });
    assertTargetUnchanged(this.identity);
  }

  async prompt(message: string, options?: PromptOptions): Promise<string> {
    if (options?.timeoutMs !== undefined) validateLimits({ settlementTimeoutMs: options.timeoutMs });
    if (this.statusValue !== "idle") throw new Error(`Cannot send to a child in ${this.statusValue} state`);
    if (Buffer.byteLength(message) > 8 * 1024) throw new Error("CLI launch message exceeds 8 KiB; provide a smaller instruction or point to a local Note.");
    assertTargetUnchanged(this.identity);
    const operationId = `${this.runId}:op-${this.turns.length + 1}`;
    const startedAt = new Date().toISOString();
    this.turns.push({ operationId, status: "running", startedAt });
    this.statusValue = "running";
    this.notify();
    const done = this.runTurn(operationId, message, startedAt, options?.timeoutMs);
    this.pending.set(operationId, done);
    return operationId;
  }

  async steer(): Promise<void> { throw new Error("Steering is not supported for a CLI turn; interrupt or wait for the reply before sending."); }
  async followUp(): Promise<void> { throw new Error("A CLI turn cannot queue a follow-up; wait for the reply before sending."); }

  async waitForTurn(operationId: string): Promise<TurnSnapshot> {
    const turn = this.turns.find((t) => t.operationId === operationId);
    if (!turn) throw new Error(`Unknown operation: ${operationId}`);
    return this.pending.get(operationId) ?? turn;
  }

  onTurnSettled(listener: TurnSettledListener): () => void {
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }
  onStateChanged(listener: StateChangedListener): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }

  async interrupt(): Promise<TurnSnapshot | undefined> {
    const active = this.active;
    if (!active) return undefined;
    active.stop("interrupted");
    return active.done;
  }

  async close(): Promise<void> {
    if (this.statusValue === "closed") return;
    const active = this.active;
    if (active) {
      active.stop("closed");
      await active.done;
    }
    this.statusValue = "closed";
    this.notify();
  }

  private runTurn(operationId: string, message: string, startedAt: string, perTurnTimeoutMs?: number): Promise<TurnSnapshot> {
    const args = ["--json", "agent", "run", this.identity.root, "--runtime", this.config.runtime,
      `--message=${message}`];
    if (this.conversationId) args.push("--conversation", this.conversationId);
    else if (this.config.topic) args.push("--topic", this.config.topic);
    if (this.config.runtime === "pi") {
      args.push("--ext", this.config.extensionPaths!.join(","));
      if (this.config.skillPaths?.length) args.push("--skill", this.config.skillPaths.join(","));
    }
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.thinking) args.push("--pi-thinking", this.config.thinking);
    if (this.config.runtime === "pi") args.push("--pi-trust", this.config.trust ?? "saved");
    if (this.config.runtime === "claude") {
      if (this.config.effort) args.push("--claude-effort", this.config.effort);
      args.push("--permission-mode", this.config.permissionMode ?? (this.config.readOnly === false ? "acceptEdits" : "dontAsk"));
      if (this.config.readOnly !== false) args.push("--read-only");
    }
    const isScript = /[\\/]/.test(this.cliPath) && /\.(?:[cm]?js)$/.test(this.cliPath);
    const command = isScript ? process.execPath : this.cliPath;
    const argv = isScript ? [this.cliPath, ...args] : args;
    const limits = this.config.limits;
    const maxLine = limits?.maxLineBytes ?? MAX_LINE_BYTES;
    const maxReply = limits?.maxReplyChars ?? MAX_REPLY_CHARS;
    const maxError = limits?.maxStderrBytes ?? MAX_ERROR_CHARS;
    const timeout = perTurnTimeoutMs !== undefined ? perTurnTimeoutMs : (limits?.settlementTimeoutMs ?? 0);

    return new Promise<TurnSnapshot>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(command, argv, {
          cwd: this.identity.root, shell: false, detached: true, windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...this.config.env, PI_AGENT_SESSION_DEPTH: "1",
            IDEASPACES_PI_EXTENSIONS: undefined, IDEASPACES_PI_SKILLS: undefined },
        });
      } catch (err) {
        this.finish({ operationId, status: "failed", startedAt, error: String(err) }, resolve);
        return;
      }
      this.child = child;
      let line = "";
      let reply = "";
      let error = "";
      let complete = false;
      let failure = false;
      let ended = false;
      let stopReason: "interrupted" | "closed" | "timeout" | "overflow" | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = (reason: "interrupted" | "closed" | "timeout" | "overflow") => {
        if (stopReason) return;
        stopReason = reason;
        signalTree(child, "SIGTERM");
        killTimer = setTimeout(() => signalTree(child, "SIGKILL"), limits?.killGraceMs ?? KILL_GRACE_MS);
        killTimer.unref();
      };
      const onParentExit = () => signalTree(child, "SIGKILL");
      process.once("exit", onParentExit);
      let deadline: NodeJS.Timeout | undefined;
      if (timeout > 0) {
        deadline = setTimeout(() => stop("timeout"), timeout);
      }
      const done = new Promise<TurnSnapshot>((doneResolve) => {
        const settle = (code: number | null, signal: NodeJS.Signals | null) => {
          if (ended) return;
          ended = true;
          if (deadline) clearTimeout(deadline);
          if (killTimer) clearTimeout(killTimer);
          process.off("exit", onParentExit);
          this.child = undefined;
          this.active = undefined;
          const status = stopReason === "interrupted" || stopReason === "closed" ? "interrupted"
            : code === 0 && complete && !!this.conversationId && !failure && !stopReason ? "completed" : "failed";
          const detail = stopReason === "timeout" ? `CLI turn timed out after ${timeout}ms`
            : error || (signal ? `CLI exited on ${signal}` : `CLI exited ${code} without a successful turn_complete`);
          const turn: TurnSnapshot = { operationId, startedAt, settledAt: new Date().toISOString(), status,
            ...(status === "completed" ? { reply: reply.trim() } : status === "failed" ? { error: detail.slice(0, maxError) } : {}) };
          this.finish(turn, resolve);
          doneResolve(turn);
        };
        child.once("close", settle);
        child.once("error", (err) => { error = `Could not start CLI: ${err.message}`; });
      });
      this.active = { stop, done };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        line += chunk;
        if (Buffer.byteLength(line) > maxLine && !line.includes("\n")) { error = "CLI event exceeds output limit"; stop("overflow"); return; }
        let end: number;
        while ((end = line.indexOf("\n")) >= 0) {
          const raw = line.slice(0, end);
          line = line.slice(end + 1);
          if (Buffer.byteLength(raw) > maxLine) { error = "CLI event exceeds output limit"; stop("overflow"); return; }
          let event: Record<string, unknown>;
          try { event = JSON.parse(raw); } catch { error = "Invalid CLI JSON event"; stop("overflow"); return; }
          if (event.type === "message_start") {
            const id = event.conversation_id;
            if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
                (this.config.runtime === "claude" && !UUID.test(id)) ||
                (this.conversationId && id !== this.conversationId)) {
              error = "CLI returned an invalid or different conversation id";
              failure = true;
              stop("overflow");
              return;
            }
            this.conversationId = id;
            // Each turn is a fresh runtime process; its report replaces the last, including "none".
            this.observedModel = reportedModel(event.model_observed);
            this.notify();
          }
          if (event.type === "text_delta" && typeof event.delta === "string") reply = (reply + event.delta).slice(0, maxReply);
          if (event.type === "turn_complete") {
            complete = true;
            const result = event.result as { response?: unknown } | undefined;
            if (typeof result?.response === "string") reply = result.response.slice(0, maxReply);
          }
          if (event.type === "error") { failure = true; error = String(event.message ?? "Child failed").slice(0, maxError); }
          if (event.type === "cancelled") { failure = true; error = "Child cancelled"; }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { error = (error + chunk).slice(0, maxError); });
    });
  }

  private finish(turn: TurnSnapshot, resolve: (turn: TurnSnapshot) => void): void {
    const i = this.turns.findIndex((t) => t.operationId === turn.operationId);
    this.turns[i] = turn;
    if (this.statusValue !== "closed") this.statusValue = "idle";
    this.pending.delete(turn.operationId);
    for (const listener of this.settled) { try { listener(turn); } catch { /* observer cannot stall settlement */ } }
    this.notify();
    resolve(turn);
  }
  private notify(): void { for (const listener of this.changed) { try { listener(); } catch { /* observer */ } } }
}

function requiredFeatures(config: CliControllerConfig): string[] {
  if (config.runtime === "pi") {
    return ["pi.explicit-extensions", "pi.skill-isolation", "pi.trust", ...(config.thinking ? ["pi.thinking"] : []), ...(config.topic ? ["pi.topic"] : [])];
  }
  return ["claude.permission-mode", ...(config.readOnly !== false ? ["claude.read-only"] : []),
    ...(config.effort ? ["claude.effort"] : [])];
}

/** The feature set from `agent capabilities --json`, or undefined when it is not that document. */
export function parseCapabilities(out: string): Set<string> | undefined {
  let doc: unknown;
  try { doc = JSON.parse(out); } catch { return undefined; }
  const caps = doc as { schema?: unknown; version?: unknown; features?: unknown } | null;
  if (caps?.schema !== CAPABILITIES_SCHEMA || typeof caps.version !== "number" || caps.version < 1 ||
      !Array.isArray(caps.features)) return undefined;
  return new Set(caps.features.filter((feature): feature is string => typeof feature === "string"));
}

/** A runtime-reported model id fit for display, or undefined. */
export function reportedModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function targetIdentity(path: string): TargetIdentity {
  const root = realpathSync(path);
  const stat = lstatSync(root);
  const contract = lstatSync(join(root, "_agent", "agreement.md"));
  if (!stat.isDirectory() || !contract.isFile() || contract.isSymbolicLink()) {
    throw new Error(`Selected POV must have a regular _agent/agreement.md: ${path}`);
  }
  return { root, device: stat.dev, inode: stat.ino, contractDevice: contract.dev, contractInode: contract.ino };
}
function assertTargetUnchanged(expected: TargetIdentity): void {
  try {
    const current = targetIdentity(expected.root);
    if (current.device === expected.device && current.inode === expected.inode &&
        current.contractDevice === expected.contractDevice && current.contractInode === expected.contractInode) return;
  } catch { /* changed or missing */ }
  throw new Error(`Agent point of view changed before launch: ${expected.root}`);
}
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}
