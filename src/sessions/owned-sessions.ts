import { PersistentRpcController } from "../controller/controller.js";
import { CliAgentController } from "../controller/cli-controller.js";
import { DEFAULT_LIMITS, validateLimits } from "../controller/config.js";
import type { AgentSessionSnapshot, TurnSnapshot } from "../controller/types.js";
import { discoverAgentRoster, resolveAgentTarget, revalidateAgentTarget } from "../discovery/discovery.js";
import type { AgentRoster, AgentRosterEntry } from "../discovery/types.js";
import { listAgentConversations, resolveAgentConversation } from "../conversations/catalog.js";
import { acquireConversationLease } from "../conversations/lease.js";
import type {
  AgentReply,
  OwnedAgentSessionsConfig,
  OwnedAgentSessionsDependencies,
  OwnedAgentSessionsHooks,
  OwnedRunSnapshot,
  OwnedSessionsList,
  OwnedSessionsStatus,
  ListConversationsInput,
  ListConversationsResult,
  SendSessionInput,
  ResumeSessionInput,
  SessionController,
  SessionOperationResult,
  SessionPointer,
  StartSessionInput,
  StatusOptions,
} from "./types.js";

interface ManagedRun {
  agent: string;
  controller: SessionController;
  createdEpoch: number;
  operationEpochs: Map<string, number>;
  watchedOperations: Set<string>;
  settledOperations: Set<string>;
  pendingSettlements: Map<string, TurnSnapshot>;
  unread: AgentReply[];
  commandTail: Promise<void>;
  unsubscribeSettled?: () => void;
  unsubscribeUi?: () => void;
  unsubscribeState?: () => void;
  closedPointerWritten: boolean;
  releaseLease?: () => void;
}

export class OwnedAgentSessions {
  private readonly createController: NonNullable<OwnedAgentSessionsDependencies["createController"]>;
  private readonly createClaudeController: NonNullable<OwnedAgentSessionsDependencies["createClaudeController"]>;
  private readonly now: () => Date;
  private readonly runs = new Map<string, ManagedRun>();
  private branchEpoch = 0;
  private generation = 0;
  private accepting = true;
  private startTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    readonly config: OwnedAgentSessionsConfig,
    private readonly hooks: OwnedAgentSessionsHooks,
    dependencies: OwnedAgentSessionsDependencies = {},
  ) {
    this.createController = dependencies.createController ?? ((input) => PersistentRpcController.start(input));
    this.createClaudeController = dependencies.createClaudeController ?? ((input) => CliAgentController.start(input));
    this.now = dependencies.now ?? (() => new Date());
    validateDepth(config.depth);
  }

  currentBranchEpoch(): number {
    return this.branchEpoch;
  }

  advanceBranch(): number {
    this.branchEpoch += 1;
    return this.branchEpoch;
  }

  async list(): Promise<OwnedSessionsList> {
    const runs = [...this.runs.values()].map((run) => this.snapshotRun(run, false));
    if (!this.config.collectionRoot) {
      return {
        runs,
        configurationError:
          "No agent collection is configured. Pass an explicit repository path with _agent/agreement.md to start a fellow session.",
      };
    }
    const roster = await this.refreshRoster();
    return { roster, runs };
  }

  async conversations(input: ListConversationsInput): Promise<ListConversationsResult> {
    this.requireAccepting();
    validateTarget(input.agent);
    const target = await this.resolveTarget(input.agent);
    return listAgentConversations(target.name, target.path, {
      query: input.query,
      limits: this.config.conversations,
      agentDir: this.config.controller?.agentDir,
      env: this.config.controller?.env,
    });
  }

  async start(input: StartSessionInput): Promise<SessionOperationResult> {
    return this.serializeStart(async () => {
      this.requireAccepting();
      if ((this.config.depth ?? 0) > 0) {
        throw new Error("Nested agent sessions are disabled in this release");
      }
      validateMessage(input.message);
      validateTarget(input.agent);
      validateTopic(input.topic);
      const target = await this.resolveTarget(input.agent);
      const liveCount = [...this.runs.values()].filter((run) => isLive(run.controller.snapshot())).length;
      const maxChildren = validateLimits(this.config.controller?.limits).maxChildren;
      if (liveCount >= maxChildren) throw new Error(`Owned live session limit reached (${maxChildren})`);

      const runtime = input.runtime ?? "pi";
      validateRuntimeOptions(runtime, input.thinking, input.permissionMode);
      const useCli = runtime === "claude" || isExplicitTarget(input.agent, this.config.collectionRoot);
      if (useCli && input.topic) throw new Error("CLI launches name the conversation from its first message; topic is available only to resident Pi runs.");
      let controller: SessionController;
      if (useCli) {
        controller = await this.createClaudeController({
          target: target.path,
          runtime,
          model: input.model,
          thinking: input.thinking,
          permissionMode: input.permissionMode,
          trust: this.config.approveProjectResources ? "explicit" : "saved",
          limits: this.config.controller?.limits,
          env: this.config.controller?.env,
        });
      } else {
        controller = await this.createController({
          ...this.config.controller,
          target: target.path,
          trust: this.config.approveProjectResources ? { mode: "explicit" } : { mode: "saved" },
          model: input.model,
          thinking: input.thinking,
          sessionName: input.topic?.trim(),
        });
      }
      const run = this.registerRun(target.name, controller);
      const operation = await this.beginPrompt(run, input.message);
      this.hooks.stateChanged?.();
      return { run: this.snapshotRun(run, false), operation };
    });
  }

  async resume(input: ResumeSessionInput): Promise<SessionOperationResult> {
    return this.serializeStart(async () => {
      this.requireAccepting();
      if ((this.config.depth ?? 0) > 0) throw new Error("Nested agent sessions are disabled in this release");
      validateMessage(input.message);
      validateTarget(input.agent);
      const target = await this.resolveTarget(input.agent);
      const liveCount = [...this.runs.values()].filter((run) => isLive(run.controller.snapshot())).length;
      const maxChildren = validateLimits(this.config.controller?.limits).maxChildren;
      if (liveCount >= maxChildren) throw new Error(`Owned live session limit reached (${maxChildren})`);

      const isClaudeId = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(input.conversationId);
      const runtime = input.runtime ?? (isClaudeId ? "claude" : "pi");
      validateRuntimeOptions(runtime, input.thinking, input.permissionMode);
      const useCli = runtime === "claude" || isExplicitTarget(input.agent, this.config.collectionRoot);

      let controller: SessionController | undefined;
      let releaseLease: (() => void) | undefined;

      if (useCli) {
        controller = await this.createClaudeController({
          target: target.path,
          runtime,
          model: input.model,
          thinking: input.thinking,
          permissionMode: input.permissionMode,
          trust: this.config.approveProjectResources ? "explicit" : "saved",
          resumeConversationId: input.conversationId,
          limits: this.config.controller?.limits,
          env: this.config.controller?.env,
        });
      } else {
        const options = {
          limits: this.config.conversations,
          agentDir: this.config.controller?.agentDir,
          env: this.config.controller?.env,
        };
        const selected = resolveAgentConversation(target.path, input.conversationId, options);
        const lease = acquireConversationLease(
          selected.path,
          this.config.controller?.agentDir,
          this.config.controller?.env,
        );
        releaseLease = lease.release;
        try {
          const revalidated = resolveAgentConversation(target.path, input.conversationId, options);
          if (revalidated.path !== selected.path) throw new Error("Conversation path changed before resume");
          controller = await this.createController({
            ...this.config.controller,
            target: target.path,
            trust: this.config.approveProjectResources ? { mode: "explicit" } : { mode: "saved" },
            model: input.model,
            thinking: input.thinking,
            resumeSession: { path: revalidated.path, conversationId: input.conversationId },
          });
          const childPid = controller.snapshot().pid;
          if (!childPid) throw new Error("Resumed controller did not expose its process id");
          lease.setOwnerPid(childPid);
        } catch (error) {
          await controller?.close().catch(() => undefined);
          lease.release();
          throw error;
        }
      }

      const run = this.registerRun(target.name, controller, releaseLease);
      try {
        const operation = await this.beginPrompt(run, input.message);
        this.hooks.stateChanged?.();
        return { run: this.snapshotRun(run, false), operation };
      } catch (error) {
        await controller.close().catch(() => undefined);
        this.releaseRunLease(run);
        this.unsubscribeRun(run);
        this.runs.delete(controller.runId);
        throw error;
      }
    });
  }

  async send(input: SendSessionInput): Promise<SessionOperationResult> {
    const run = this.requireRun(input.runId);
    return this.serializeRun(run, async () => {
      this.requireAccepting();
      validateMessage(input.message);
      const snapshot = run.controller.snapshot();
      if (snapshot.status === "idle") {
        const operation = await this.beginPrompt(run, input.message);
        return { run: this.snapshotRun(run, false), operation };
      }
      if (snapshot.status === "running" || snapshot.status === "waiting_for_input") {
        if (!input.busyMode) {
          throw new Error("The child is busy; set busyMode to steer or followUp");
        }
        const active = latestActiveTurn(snapshot);
        if (!active) throw new Error("The child reports busy without an active operation");
        if (input.busyMode === "steer") await run.controller.steer(input.message);
        else await run.controller.followUp(input.message);
        return {
          run: this.snapshotRun(run, false),
          queuedToOperationId: active.operationId,
        };
      }
      throw new Error(`Cannot send to a child in ${snapshot.status} state`);
    });
  }

  status(options: StatusOptions = {}): OwnedSessionsStatus {
    const selected = options.runId ? [this.requireRun(options.runId)] : [...this.runs.values()];
    const unread = selected.flatMap((run) => run.unread.map((reply) => ({ ...reply })));
    const result = {
      runs: selected.map((run) => this.snapshotRun(run, options.includeEvents === true)),
      unread,
    };
    if (options.consumeUnread) {
      for (const run of selected) run.unread = [];
      this.hooks.stateChanged?.();
    }
    return result;
  }

  async respondToDialog(
    runId: string,
    id: string,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): Promise<void> {
    const run = this.requireRun(runId);
    return this.serializeRun(run, async () => {
      this.requireAccepting();
      if (!run.controller.respondToDialog) throw new Error("This session controller cannot answer dialogs");
      await run.controller.respondToDialog(id, response);
      this.hooks.stateChanged?.();
    });
  }

  async interrupt(runId: string): Promise<SessionOperationResult> {
    const run = this.requireRun(runId);
    return this.serializeRun(run, async () => {
      const operation = await run.controller.interrupt();
      this.hooks.stateChanged?.();
      return { run: this.snapshotRun(run, false), operation };
    });
  }

  async close(runId: string): Promise<OwnedRunSnapshot> {
    const run = this.requireRun(runId);
    return this.serializeRun(run, async () => {
      try {
        await run.controller.close();
      } finally {
        this.releaseRunLease(run);
        this.unsubscribeRun(run);
        this.writePointer(run, "closed");
        this.hooks.stateChanged?.();
      }
      return this.snapshotRun(run, false);
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    this.generation += 1;
    this.shutdownPromise = Promise.all(
      [...this.runs.values()].map((run) =>
        this.serializeRun(run, async () => {
          await run.controller.close().catch(() => undefined);
          this.releaseRunLease(run);
          this.unsubscribeRun(run);
          this.writePointer(run, "closed");
        }),
      ),
    ).then(() => {
      this.hooks.stateChanged?.();
    });
    return this.shutdownPromise;
  }

  private registerRun(agent: string, controller: SessionController, releaseLease?: () => void): ManagedRun {
    const runGeneration = this.generation;
    const run: ManagedRun = {
      agent,
      controller,
      createdEpoch: this.branchEpoch,
      operationEpochs: new Map(),
      watchedOperations: new Set(),
      settledOperations: new Set(),
      pendingSettlements: new Map(),
      unread: [],
      commandTail: Promise.resolve(),
      closedPointerWritten: false,
      releaseLease,
    };
    if (controller.onTurnSettled) {
      run.unsubscribeSettled = controller.onTurnSettled((turn) => {
        if (!run.operationEpochs.has(turn.operationId)) {
          run.pendingSettlements.set(turn.operationId, turn);
          return;
        }
        void this.settleOperation(run, turn, runGeneration);
      });
    }
    if (controller.onUiEvent) {
      run.unsubscribeUi = controller.onUiEvent((event) => {
        if (this.runs.get(controller.runId) !== run) return;
        if (!this.accepting && event.type === "request") return;
        this.hooks.uiEvent?.({ agent: run.agent, runId: controller.runId, event });
      });
    }
    if (controller.onStateChanged) {
      run.unsubscribeState = controller.onStateChanged(() => {
        if (this.runs.get(controller.runId) !== run) return;
        this.hooks.stateChanged?.();
      });
    }
    this.runs.set(controller.runId, run);
    this.writePointer(run, "started");
    return run;
  }

  private releaseRunLease(run: ManagedRun): void {
    run.releaseLease?.();
    run.releaseLease = undefined;
  }

  private unsubscribeRun(run: ManagedRun): void {
    run.unsubscribeSettled?.();
    run.unsubscribeUi?.();
    run.unsubscribeState?.();
    run.unsubscribeSettled = undefined;
    run.unsubscribeUi = undefined;
    run.unsubscribeState = undefined;
  }

  private async refreshRoster(): Promise<AgentRoster> {
    return discoverAgentRoster(this.requireCollectionRoot(), this.config.discovery);
  }

  private async beginPrompt(run: ManagedRun, message: string): Promise<TurnSnapshot> {
    const epoch = this.branchEpoch;
    try {
      const operationId = await run.controller.prompt(message);
      run.operationEpochs.set(operationId, epoch);
      const operation = findTurn(run.controller.snapshot(), operationId);
      const pendingSettlement = run.pendingSettlements.get(operationId);
      if (pendingSettlement) {
        run.pendingSettlements.delete(operationId);
        await this.settleOperation(run, pendingSettlement, this.generation);
      } else if (isTerminalTurn(operation)) {
        await this.settleOperation(run, operation, this.generation);
      } else {
        this.watchOperation(run, operationId, this.generation);
      }
      return operation;
    } catch (error) {
      const operation = latestTerminalTurn(run.controller.snapshot());
      if (!operation) throw error;
      run.operationEpochs.set(operation.operationId, epoch);
      run.pendingSettlements.delete(operation.operationId);
      await this.settleOperation(run, operation, this.generation);
      return operation;
    }
  }

  private watchOperation(run: ManagedRun, operationId: string, generation: number): void {
    if (run.controller.onTurnSettled || run.watchedOperations.has(operationId)) return;
    run.watchedOperations.add(operationId);
    void run.controller
      .waitForTurn(operationId)
      .then((turn) => this.settleOperation(run, turn, generation))
      .catch((error) => {
        const snapshot = run.controller.snapshot();
        const turn = snapshot.turns.find((candidate) => candidate.operationId === operationId);
        if (turn && isTerminalTurn(turn)) return this.settleOperation(run, turn, generation);
        return this.settleOperation(
          run,
          {
            operationId,
            status: "failed",
            startedAt: this.now().toISOString(),
            settledAt: this.now().toISOString(),
            error: errorMessage(error),
          },
          generation,
        );
      });
  }

  private async settleOperation(run: ManagedRun, turn: TurnSnapshot, generation: number): Promise<void> {
    if (run.settledOperations.has(turn.operationId)) return;
    run.settledOperations.add(turn.operationId);
    const reply: AgentReply = {
      agent: run.agent,
      runId: run.controller.runId,
      operationId: turn.operationId,
      outcome: turn.status,
      reply: turn.reply,
      error: turn.error,
      settledAt: turn.settledAt,
      branchEpoch: run.operationEpochs.get(turn.operationId) ?? run.createdEpoch,
    };

    const isCurrentOwner = this.runs.get(run.controller.runId) === run;
    if (!this.accepting || generation !== this.generation || !isCurrentOwner) return;
    if (reply.branchEpoch !== this.branchEpoch) {
      this.holdReply(run, reply);
      return;
    }
    try {
      this.hooks.deliver(reply);
    } catch {
      this.holdReply(run, reply);
    }
  }

  private holdReply(run: ManagedRun, reply: AgentReply): void {
    run.unread.push(reply);
    const maxUnread = this.config.controller?.limits?.maxTurns ?? DEFAULT_LIMITS.maxTurns;
    while (run.unread.length > maxUnread) run.unread.shift();
    this.hooks.replyHeld?.(reply);
  }

  private snapshotRun(run: ManagedRun, includeEvents: boolean): OwnedRunSnapshot {
    const session = run.controller.snapshot();
    return {
      agent: run.agent,
      branchEpoch: run.createdEpoch,
      unreadReplies: run.unread.length,
      session: includeEvents ? session : { ...session, recentEvents: [] },
    };
  }

  private writePointer(run: ManagedRun, event: SessionPointer["event"]): void {
    if (event === "closed" && run.closedPointerWritten) return;
    if (event === "closed") run.closedPointerWritten = true;
    const snapshot = run.controller.snapshot();
    this.hooks.pointer?.({
      event,
      agent: run.agent,
      runId: snapshot.runId,
      cwd: snapshot.cwd,
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      at: this.now().toISOString(),
    });
  }

  private async resolveTarget(agentOrPath: string): Promise<AgentRosterEntry> {
    return resolveAgentTarget(this.config.collectionRoot, agentOrPath);
  }

  private requireRun(runId: string): ManagedRun {
    if (typeof runId !== "string" || runId.trim() === "" || runId.includes("\0")) {
      throw new Error("runId must be a non-empty string without NUL bytes");
    }
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown or foreign runId: ${runId}`);
    return run;
  }

  private requireCollectionRoot(): string {
    if (!this.config.collectionRoot) {
      throw new Error(
        "No agent collection is configured. Set PI_AGENT_SESSIONS_CONFIG or pass --agent-collection <absolute-path>.",
      );
    }
    return this.config.collectionRoot;
  }

  private requireAccepting(): void {
    if (!this.accepting) throw new Error("The parent session is shutting down");
  }

  private serializeRun<T>(run: ManagedRun, action: () => Promise<T>): Promise<T> {
    const result = run.commandTail.then(action, action);
    run.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private serializeStart<T>(action: () => Promise<T>): Promise<T> {
    const result = this.startTail.then(action, action);
    this.startTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function findTurn(snapshot: AgentSessionSnapshot, operationId: string): TurnSnapshot {
  const turn = snapshot.turns.find((candidate) => candidate.operationId === operationId);
  if (!turn) throw new Error(`Controller did not retain operation ${operationId}`);
  return turn;
}

function latestActiveTurn(snapshot: AgentSessionSnapshot): TurnSnapshot | undefined {
  return [...snapshot.turns].reverse().find((turn) => turn.status === "pending" || turn.status === "running");
}

function latestTerminalTurn(snapshot: AgentSessionSnapshot): TurnSnapshot | undefined {
  return [...snapshot.turns].reverse().find(isTerminalTurn);
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === "rejected" || turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
}

function isLive(snapshot: AgentSessionSnapshot): boolean {
  return snapshot.status !== "closed" && snapshot.status !== "crashed";
}

function validateDepth(depth: number | undefined): void {
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0 || depth > 32)) {
    throw new Error("depth must be an integer between 0 and 32");
  }
}

function isExplicitTarget(agent: string, collectionRoot?: string): boolean {
  return !collectionRoot || agent === "." || agent.includes("/") || agent.includes("\\");
}

function validateRuntimeOptions(runtime: "pi" | "claude", thinking?: string, permissionMode?: string): void {
  if (runtime === "claude" && thinking) throw new Error("Pi thinking levels are not supported by Claude; omit thinking.");
  if (runtime === "pi" && permissionMode) throw new Error("Claude permission mode is not supported by Pi; omit permissionMode.");
}

function validateTarget(value: string, field = "agent"): void {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty name or path without NUL bytes`);
  }
}

function validateName(name: string): void {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error("agent must be one discovered immediate-child name");
  }
}

function validateMessage(message: string): void {
  if (typeof message !== "string" || message.trim() === "" || message.includes("\0")) {
    throw new Error("message must be a non-empty string without NUL bytes");
  }
}

function validateTopic(topic: string | undefined): void {
  if (topic === undefined) return;
  if (typeof topic !== "string" || topic.trim() === "" || topic.includes("\0")) {
    throw new Error("topic must be non-empty text without NUL bytes");
  }
  if (topic.trim().length > 200) throw new Error("topic cannot exceed 200 characters");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
