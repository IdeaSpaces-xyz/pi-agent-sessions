import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionSnapshot, PromptOptions, TurnSnapshot } from "../src/controller/types.js";
import { OwnedAgentSessions } from "../src/sessions/owned-sessions.js";
import type {
  AgentReply,
  SessionController,
  SessionPointer,
} from "../src/sessions/types.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-owned-sessions-"));
  roots.push(root);
  return root;
}

async function makeAgent(root: string, name: string): Promise<void> {
  await mkdir(join(root, name, "_agent"), { recursive: true });
  await writeFile(join(root, name, "_agent", "foundation.md"), `# ${name}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeController implements SessionController {
  private static sequence = 0;
  readonly runId = `run-${++FakeController.sequence}`;
  private status: AgentSessionSnapshot["status"] = "idle";
  private turns: TurnSnapshot[] = [];
  private completions = new Map<string, ReturnType<typeof deferred<TurnSnapshot>>>();
  readonly queued: string[] = [];
  closed = false;
  maxConcurrentCommands = 0;
  private concurrentCommands = 0;

  constructor(readonly target: string) {}

  snapshot(): AgentSessionSnapshot {
    return {
      runId: this.runId,
      pid: 1000 + FakeController.sequence,
      cwd: this.target,
      status: this.status,
      sessionId: `session-${this.runId}`,
      sessionFile: join(this.target, ".pi", "sessions", `${this.runId}.jsonl`),
      activeTools: this.status === "running" ? [{ toolCallId: "tool-1", toolName: "read" }] : [],
      outstandingRequestIds: [],
      outstandingDialogs: [],
      recentEvents: [{ type: "fake_progress" }],
      turns: this.turns.map((turn) => ({ ...turn })),
      stderr: "",
    };
  }

  async prompt(_message: string, _options?: PromptOptions): Promise<string> {
    const operationId = `${this.runId}:op-${this.turns.length + 1}`;
    this.turns.push({ operationId, status: "running", startedAt: new Date().toISOString() });
    this.completions.set(operationId, deferred<TurnSnapshot>());
    this.status = "running";
    return operationId;
  }

  async steer(message: string): Promise<void> {
    await this.trackCommand(`steer:${message}`);
  }

  async followUp(message: string): Promise<void> {
    await this.trackCommand(`followUp:${message}`);
  }

  waitForTurn(operationId: string): Promise<TurnSnapshot> {
    const completion = this.completions.get(operationId);
    if (!completion) throw new Error(`Unknown operation: ${operationId}`);
    return completion.promise;
  }

  async interrupt(): Promise<TurnSnapshot | undefined> {
    const active = [...this.turns].reverse().find((turn) => turn.status === "running");
    if (!active) return undefined;
    return this.settle(active.operationId, "interrupted", undefined, "aborted");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const active = [...this.turns].reverse().find((turn) => turn.status === "running");
    if (active) this.settle(active.operationId, "interrupted", undefined, "aborted");
    this.closed = true;
    this.status = "closed";
  }

  settle(
    operationId: string,
    status: TurnSnapshot["status"] = "completed",
    reply = "finished",
    stopReason = "stop",
  ): TurnSnapshot {
    const turn = this.turns.find((candidate) => candidate.operationId === operationId);
    if (!turn) throw new Error(`Unknown operation: ${operationId}`);
    Object.assign(turn, {
      status,
      reply,
      stopReason,
      settledAt: new Date().toISOString(),
    });
    this.status = "idle";
    this.completions.get(operationId)?.resolve({ ...turn });
    return { ...turn };
  }

  private async trackCommand(value: string): Promise<void> {
    this.concurrentCommands += 1;
    this.maxConcurrentCommands = Math.max(this.maxConcurrentCommands, this.concurrentCommands);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.queued.push(value);
    this.concurrentCommands -= 1;
  }
}

function harness(root: string, options: { depth?: number; maxChildren?: number } = {}) {
  const controllers: FakeController[] = [];
  const delivered: AgentReply[] = [];
  const held: AgentReply[] = [];
  const pointers: SessionPointer[] = [];
  const sessions = new OwnedAgentSessions(
    {
      collectionRoot: root,
      depth: options.depth,
      controller: { limits: { maxChildren: options.maxChildren ?? 4 } },
    },
    {
      deliver: (reply) => delivered.push(reply),
      replyHeld: (reply) => held.push(reply),
      pointer: (pointer) => pointers.push(pointer),
    },
    {
      createController: async (config) => {
        const controller = new FakeController(config.target);
        controllers.push(controller);
        return controller;
      },
    },
  );
  return { sessions, controllers, delivered, held, pointers };
}

describe("OwnedAgentSessions", () => {
  it("refreshes a bounded roster and starts only discovered immediate agents", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    await makeAgent(root, "Frontend");
    const { sessions, controllers, pointers } = harness(root);

    const list = await sessions.list();
    expect(list.roster?.agents.map((agent) => agent.name)).toEqual(["Backend", "Frontend"]);
    await expect(sessions.start({ agent: "../outside", message: "hello" })).rejects.toThrow("immediate-child");

    const started = await sessions.start({ agent: "Backend", message: "Review this" });
    expect(started.run).toMatchObject({ agent: "Backend", session: { status: "running" } });
    expect(started.operation?.status).toBe("running");
    expect(controllers[0].target).toBe(list.roster?.agents[0].path);
    expect(pointers).toEqual([expect.objectContaining({ event: "started", agent: "Backend" })]);
  });

  it("rejects nested launch before creating a controller", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    const { sessions, controllers } = harness(root, { depth: 1 });
    await expect(sessions.start({ agent: "Backend", message: "hello" })).rejects.toThrow("Nested");
    expect(controllers).toHaveLength(0);
  });

  it("enforces the live child cap and rejects foreign run ids", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    await makeAgent(root, "Frontend");
    const { sessions } = harness(root, { maxChildren: 1 });
    await sessions.start({ agent: "Backend", message: "one" });
    await expect(sessions.start({ agent: "Frontend", message: "two" })).rejects.toThrow("limit");
    expect(() => sessions.status({ runId: "foreign" })).toThrow("foreign");
    await expect(sessions.interrupt("foreign")).rejects.toThrow("foreign");

    const otherParent = harness(root);
    const otherRun = await otherParent.sessions.start({ agent: "Backend", message: "separate owner" });
    expect(() => sessions.status({ runId: otherRun.run.session.runId })).toThrow("foreign");
  });

  it("serializes commands per child and requires an explicit busy policy", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    const { sessions, controllers } = harness(root);
    const started = await sessions.start({ agent: "Backend", message: "work" });
    const runId = started.run.session.runId;

    await expect(sessions.send({ runId, message: "unplanned" })).rejects.toThrow("busy");
    const [steered, followed] = await Promise.all([
      sessions.send({ runId, message: "change", busyMode: "steer" }),
      sessions.send({ runId, message: "summarize", busyMode: "followUp" }),
    ]);

    expect(steered.queuedToOperationId).toBe(started.operation?.operationId);
    expect(followed.queuedToOperationId).toBe(started.operation?.operationId);
    expect(controllers[0].queued).toEqual(["steer:change", "followUp:summarize"]);
    expect(controllers[0].maxConcurrentCommands).toBe(1);
  });

  it("delivers one labelled outcome only while the originating branch still owns it", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    const { sessions, controllers, delivered } = harness(root);
    const started = await sessions.start({ agent: "Backend", message: "work" });
    controllers[0].settle(started.operation!.operationId, "completed", "answer");
    controllers[0].settle(started.operation!.operationId, "completed", "duplicate");
    await tick();

    expect(delivered).toEqual([
      expect.objectContaining({
        agent: "Backend",
        runId: started.run.session.runId,
        operationId: started.operation?.operationId,
        outcome: "completed",
        reply: "answer",
        branchEpoch: 0,
      }),
    ]);
    await tick();
    expect(delivered).toHaveLength(1);
  });

  it("holds branch-stale replies until status retrieves them", async () => {
    const root = tempRoot();
    await makeAgent(root, "Frontend");
    const { sessions, controllers, delivered, held } = harness(root);
    const started = await sessions.start({ agent: "Frontend", message: "work" });
    sessions.advanceBranch();
    controllers[0].settle(started.operation!.operationId, "completed", "old branch answer");
    await tick();

    expect(delivered).toEqual([]);
    expect(held).toEqual([expect.objectContaining({ reply: "old branch answer", branchEpoch: 0 })]);
    expect(sessions.status().runs[0].unreadReplies).toBe(1);
    expect(sessions.status({ consumeUnread: true }).unread).toEqual([
      expect.objectContaining({ reply: "old branch answer" }),
    ]);
    expect(sessions.status().unread).toEqual([]);
  });

  it("runs simultaneous children independently and omits event payloads unless requested", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    await makeAgent(root, "Frontend");
    const { sessions, controllers, delivered } = harness(root);
    const [backend, frontend] = await Promise.all([
      sessions.start({ agent: "Backend", message: "one" }),
      sessions.start({ agent: "Frontend", message: "two" }),
    ]);
    controllers[1].settle(frontend.operation!.operationId, "completed", "front");
    controllers[0].settle(backend.operation!.operationId, "completed", "back");
    await tick();

    expect(delivered.map((reply) => reply.reply).sort()).toEqual(["back", "front"]);
    expect(sessions.status().runs.every((run) => run.session.recentEvents.length === 0)).toBe(true);
    expect(sessions.status({ runId: backend.run.session.runId, includeEvents: true }).runs[0].session.recentEvents).toHaveLength(1);
  });

  it("invalidates callbacks and closes every child idempotently on parent teardown", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    await makeAgent(root, "Frontend");
    const { sessions, controllers, delivered, pointers } = harness(root);
    const backend = await sessions.start({ agent: "Backend", message: "one" });
    await sessions.start({ agent: "Frontend", message: "two" });

    await sessions.shutdown();
    controllers[0].settle(backend.operation!.operationId, "completed", "too late");
    await sessions.shutdown();
    await tick();

    expect(controllers.every((controller) => controller.closed)).toBe(true);
    expect(delivered).toEqual([]);
    expect(pointers.filter((pointer) => pointer.event === "closed")).toHaveLength(2);
    await expect(sessions.start({ agent: "Backend", message: "again" })).rejects.toThrow("shutting down");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
