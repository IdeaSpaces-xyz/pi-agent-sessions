import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentRpcController, RpcCommandError } from "../src/controller/controller.js";
import type { AgentSessionControllerConfig } from "../src/controller/types.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const roots: string[] = [];
const controllers: PersistentRpcController[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-controller-"));
  roots.push(root);
  return root;
}

function config(scenario = "normal", overrides: Partial<AgentSessionControllerConfig> = {}): AgentSessionControllerConfig {
  const target = overrides.target ?? tempRoot();
  return {
    trust: { mode: "saved" },
    executable: { command: process.execPath, argvPrefix: [fixture] },
    ...overrides,
    target,
    env: { FAKE_PI_SCENARIO: scenario, ...overrides.env },
    limits: {
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      settlementTimeoutMs: 1_000,
      closeGraceMs: 100,
      killGraceMs: 100,
      maxLineBytes: 8_192,
      maxRecentEvents: 20,
      maxTurns: 10,
      maxStderrBytes: 512,
      maxReplyChars: 512,
      maxChildren: 2,
      ...overrides.limits,
    },
  };
}

async function start(scenario = "normal", overrides: Partial<AgentSessionControllerConfig> = {}) {
  const controller = await PersistentRpcController.start(config(scenario, overrides));
  controllers.push(controller);
  return controller;
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PersistentRpcController", () => {
  it("launches with exact cwd, argv, sanitized env, and a correlated readiness handshake", async () => {
    const target = tempRoot();
    const record = join(target, "invocation.json");
    const controller = await start("normal", {
      target,
      trust: { mode: "explicit" },
      model: "provider/model",
      thinking: "high",
      sessionName: "Space Loop",
      env: { FAKE_PI_RECORD: record, FAKE_CUSTOM: "forwarded", PI_SESSION_ID: undefined },
    });
    const invocation = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    expect(invocation).toMatchObject({
      cwd: controller.snapshot().cwd,
      depth: "1",
      custom: "forwarded",
      argv: ["--mode", "rpc", "--model", "provider/model", "--thinking", "high", "--name", "Space Loop", "--approve"],
    });
    expect(invocation.sessionId).toBeUndefined();
    expect(controller.snapshot()).toMatchObject({
      cwd: controller.snapshot().cwd,
      status: "idle",
      sessionId: "fake-session",
      sessionFile: `${controller.snapshot().cwd}/.pi/sessions/fake.jsonl`,
      outstandingRequestIds: [],
    });
  });

  it("resumes an exact session and rejects identity or startup-file drift", async () => {
    const target = tempRoot();
    const sessionFile = join(target, "conversation.jsonl");
    writeFileSync(sessionFile, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "conversation-1",
      timestamp: "2026-09-08T10:00:00.000Z",
      cwd: target,
    })}\n`);
    const record = join(target, "resume-invocation.json");
    const controller = await start("normal", {
      target,
      resumeSession: { path: sessionFile, conversationId: "conversation-1" },
      env: { FAKE_PI_RECORD: record },
    });
    const canonicalSessionFile = realpathSync(sessionFile);
    expect(controller.snapshot()).toMatchObject({ sessionId: "conversation-1", sessionFile: canonicalSessionFile });
    expect(JSON.parse(readFileSync(record, "utf8")).argv).toEqual(["--mode", "rpc", "--session", canonicalSessionFile]);
    await controller.close();

    await expect(PersistentRpcController.start(config("normal", {
      target,
      resumeSession: { path: sessionFile, conversationId: "different-id" },
    }))).rejects.toThrow("header does not match conversationId");
    await expect(PersistentRpcController.start(config("mutate-resume", {
      target,
      resumeSession: { path: sessionFile, conversationId: "conversation-1" },
    }))).rejects.toThrow("header mismatch");
  });

  it("keeps one process for repeated prompts and emits each terminal outcome once", async () => {
    const controller = await start();
    const pid = controller.snapshot().pid;
    const settled: string[] = [];
    const unsubscribe = controller.onTurnSettled((turn) => settled.push(turn.operationId));
    const first = await controller.promptAndWait("first");
    const second = await controller.promptAndWait("second");
    unsubscribe();
    expect(first).toMatchObject({ status: "completed", reply: "reply 1: first", stopReason: "stop" });
    expect(second).toMatchObject({ status: "completed", reply: "reply 2: second", stopReason: "stop" });
    expect(second.operationId).not.toBe(first.operationId);
    expect(settled).toEqual([first.operationId, second.operationId]);
    expect(controller.snapshot()).toMatchObject({ pid, status: "idle", activeTools: [], outstandingRequestIds: [] });
  });

  it("waits through retry progress until agent_settled", async () => {
    const controller = await start("retry");
    const turn = await controller.promptAndWait("retry me");
    expect(turn).toMatchObject({ status: "completed", reply: "after retry" });
    expect(controller.snapshot().recentEvents.map((event) => event.type)).toContain("auto_retry_start");
    expect(controller.snapshot().recentEvents.map((event) => event.type)).not.toContain("message_update");
  });

  it("decodes split Unicode framing without treating Unicode separators as records", async () => {
    const controller = await start("split-unicode");
    const turn = await controller.promptAndWait("unicode");
    expect(turn).toMatchObject({ status: "completed", reply: "left 😀  right" });
  });

  it("records rejected prompts without crashing the reusable process", async () => {
    const controller = await start("reject");
    await expect(controller.prompt("no")).rejects.toBeInstanceOf(RpcCommandError);
    expect(controller.snapshot()).toMatchObject({ status: "idle", turns: [expect.objectContaining({ status: "rejected", error: "fake rejection" })] });
  });

  it("marks settlement without a new reply as failed instead of reusing old text", async () => {
    const controller = await start("settled-no-reply");
    const turn = await controller.promptAndWait("nothing");
    expect(turn).toMatchObject({ status: "failed", error: "Pi settled without a new assistant reply" });
    expect(turn.reply).toBeUndefined();
  });

  it("distinguishes interrupt from failure and clears queued messages before abort", async () => {
    const target = tempRoot();
    const commandRecord = join(target, "commands.jsonl");
    const controller = await start("hold", { target, env: { FAKE_COMMAND_RECORD: commandRecord } });
    const operationId = await controller.prompt("keep working");
    await controller.steer("change direction");
    await controller.followUp("then summarize");
    await waitUntil(() => controller.snapshot().activeTools.length === 2);
    expect(controller.snapshot().status).toBe("running");
    const turn = await controller.interrupt();
    expect(turn).toMatchObject({ operationId, status: "interrupted", stopReason: "aborted" });
    expect(controller.snapshot()).toMatchObject({ status: "idle", activeTools: [], outstandingRequestIds: [] });
    const commands = readFileSync(commandRecord, "utf8").trim().split("\n").map((line) => JSON.parse(line).type);
    expect(commands).toEqual(["get_state", "prompt", "steer", "follow_up", "clear_queue", "abort"]);
  });

  it("correlates and validates all four supported dialog methods", async () => {
    const target = tempRoot();
    const commandRecord = join(target, "dialog-commands.jsonl");
    const controller = await start("dialog-all", { target, env: { FAKE_COMMAND_RECORD: commandRecord } });
    const events: any[] = [];
    controller.onUiEvent((event) => events.push(event));
    const operationId = await controller.prompt("ask everything");

    await waitUntil(() => controller.snapshot().outstandingDialogs[0]?.id === "select-1");
    await expect(controller.respondToDialog("select-1", { value: "Not offered" })).rejects.toThrow("not one");
    await controller.respondToDialog("select-1", { value: "Beta" });
    await waitUntil(() => controller.snapshot().outstandingDialogs[0]?.id === "confirm-1");
    await expect(controller.respondToDialog("confirm-1", { value: "wrong shape" })).rejects.toThrow("confirmation");
    await controller.respondToDialog("confirm-1", { confirmed: false });
    await waitUntil(() => controller.snapshot().outstandingDialogs[0]?.id === "input-1");
    await controller.respondToDialog("input-1", { value: "Ada" });
    await waitUntil(() => controller.snapshot().outstandingDialogs[0]?.id === "editor-1");
    await controller.respondToDialog("editor-1", { value: "edited text" });

    const turn = await controller.waitForTurn(operationId);
    expect(turn.status).toBe("completed");
    expect(JSON.parse(turn.reply!)).toEqual([
      { type: "extension_ui_response", id: "select-1", value: "Beta" },
      { type: "extension_ui_response", id: "confirm-1", confirmed: false },
      { type: "extension_ui_response", id: "input-1", value: "Ada" },
      { type: "extension_ui_response", id: "editor-1", value: "edited text" },
    ]);
    expect(events.filter((event) => event.type === "request").map((event) => event.request.method)).toEqual([
      "select", "confirm", "input", "editor",
    ]);
    expect(events.filter((event) => event.type === "dialog_closed").map((event) => event.reason)).toEqual([
      "answered", "answered", "answered", "answered",
    ]);
  });

  it("emits typed non-blocking and unsupported child UI requests", async () => {
    const controller = await start("fire-ui");
    const events: any[] = [];
    controller.onUiEvent((event) => events.push(event));
    const turn = await controller.promptAndWait("project UI");

    expect(turn.status).toBe("completed");
    expect(events.map((event) => event.request)).toEqual([
      { id: "notify-1", method: "notify", message: "hello", notifyType: "warning" },
      { id: "status-1", method: "setStatus", statusKey: "job", statusText: "working" },
      {
        id: "widget-1",
        method: "setWidget",
        widgetKey: "job",
        widgetLines: ["one", "two"],
        widgetPlacement: "belowEditor",
      },
      { id: "title-1", method: "setTitle", title: "child title" },
      { id: "editor-text-1", method: "set_editor_text", text: "child text" },
      { id: "custom-1", method: "unsupported", requestedMethod: "customComponent" },
    ]);
  });

  it("times out a dialog, cancels the exact child request, and rejects a late answer", async () => {
    const target = tempRoot();
    const commandRecord = join(target, "timeout-commands.jsonl");
    const controller = await start("dialog-timeout", {
      target,
      env: { FAKE_COMMAND_RECORD: commandRecord },
      limits: { dialogTimeoutMs: 100 },
    });
    const events: any[] = [];
    controller.onUiEvent((event) => events.push(event));
    const operationId = await controller.prompt("wait");
    const turn = await controller.waitForTurn(operationId);

    expect(turn).toMatchObject({ status: "interrupted", reply: "timed out" });
    expect(events).toContainEqual({ type: "dialog_closed", id: "timeout-1", method: "input", reason: "timeout" });
    await expect(controller.respondToDialog("timeout-1", { value: "late" })).rejects.toThrow("Unknown or settled");
    const commands = readFileSync(commandRecord, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands).toContainEqual({ type: "extension_ui_response", id: "timeout-1", cancelled: true });
  });

  it("cancels an outstanding dialog before interrupting its turn", async () => {
    const target = tempRoot();
    const commandRecord = join(target, "interrupt-dialog-commands.jsonl");
    const controller = await start("dialog", { target, env: { FAKE_COMMAND_RECORD: commandRecord } });
    const events: any[] = [];
    controller.onUiEvent((event) => events.push(event));
    const operationId = await controller.prompt("ask");
    await waitUntil(() => controller.snapshot().outstandingDialogs.length === 1);

    const turn = await controller.interrupt();
    expect(turn).toMatchObject({ operationId, status: "interrupted" });
    expect(events).toContainEqual({ type: "dialog_closed", id: "dialog-1", method: "confirm", reason: "interrupt" });
    const commands = readFileSync(commandRecord, "utf8").trim().split("\n").map((line) => JSON.parse(line).type);
    expect(commands.indexOf("extension_ui_response")).toBeLessThan(commands.indexOf("clear_queue"));
    expect(commands.indexOf("clear_queue")).toBeLessThan(commands.indexOf("abort"));
  });

  it("tracks human dialogs and cancels them when closing", async () => {
    const target = tempRoot();
    const record = join(target, "dialog.jsonl");
    const controller = await start("dialog", { target, env: { FAKE_PI_RECORD: record } });
    const events: any[] = [];
    controller.onUiEvent((event) => events.push(event));
    await controller.prompt("ask");
    await waitUntil(() => controller.snapshot().outstandingDialogs.length === 1);
    expect(controller.snapshot().status).toBe("waiting_for_input");
    await controller.close();
    const lines = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ type: "extension_ui_response", id: "dialog-1", cancelled: true });
    expect(events).toContainEqual({ type: "dialog_closed", id: "dialog-1", method: "confirm", reason: "close" });
    expect(controller.snapshot()).toMatchObject({ status: "closed", outstandingDialogs: [], outstandingRequestIds: [] });
  });

  it("bounds concurrently retained child dialogs", async () => {
    const controller = await start("dialog-overflow", { limits: { maxDialogs: 1 } });
    await controller.prompt("overflow").catch(() => undefined);
    await waitUntil(() => controller.snapshot().status === "crashed");
    expect(controller.snapshot()).toMatchObject({
      status: "crashed",
      outstandingDialogs: [],
      protocolError: "Malformed extension UI request: Outstanding dialog limit reached (1)",
    });
  });

  it("fails a turn and process on malformed protocol or a child crash", async () => {
    const malformed = await start("parse-failure");
    const malformedId = await malformed.prompt("break framing").catch(() => malformed.snapshot().turns[0]?.operationId);
    if (malformedId) await waitUntil(() => malformed.snapshot().status === "crashed");
    expect(malformed.snapshot()).toMatchObject({ status: "crashed", protocolError: expect.stringContaining("Invalid JSONL") });
    expect(malformed.snapshot().turns[0]).toMatchObject({ status: "failed" });

    const crashed = await start("crash");
    const operationId = await crashed.prompt("crash");
    const turn = await crashed.waitForTurn(operationId);
    expect(turn).toMatchObject({ status: "failed", error: expect.stringContaining("code=17") });
    expect(crashed.snapshot()).toMatchObject({ status: "crashed", outstandingRequestIds: [] });
  });

  it("bounds observations, replies, and stderr", async () => {
    const controller = await start("normal", {
      env: { FAKE_STDERR: "x".repeat(1_000) },
      limits: { maxRecentEvents: 3, maxReplyChars: 256, maxStderrBytes: 256 },
    });
    const turn = await controller.promptAndWait("y".repeat(400));
    expect(turn.reply?.length).toBe(256);
    expect(controller.snapshot().recentEvents).toHaveLength(3);
    expect(Buffer.byteLength(controller.snapshot().stderr)).toBeLessThanOrEqual(256);
  });

  it("times out readiness and rejects malformed startup", async () => {
    await expect(PersistentRpcController.start(config("handshake-timeout", { limits: { startupTimeoutMs: 30 } }))).rejects.toThrow("Timed out waiting for get_state");
    await expect(PersistentRpcController.start(config("malformed-start"))).rejects.toThrow("Invalid JSONL");
  });

  it("closes a cooperative process gracefully without pending work", async () => {
    const controller = await start();
    const pid = controller.snapshot().pid!;
    expect(processExists(pid)).toBe(true);
    await controller.close();
    expect(processExists(pid)).toBe(false);
    expect(controller.snapshot()).toMatchObject({ status: "closed", outstandingRequestIds: [] });
  });

  it("escalates close to the owned process group so descendants do not survive", async () => {
    if (process.platform === "win32") return;
    const target = tempRoot();
    const descendantRecord = join(target, "descendant.pid");
    const controller = await start("stubborn-descendant", {
      target,
      env: { FAKE_DESCENDANT_RECORD: descendantRecord },
      limits: { closeGraceMs: 30, killGraceMs: 500 },
    });
    await waitUntil(() => existsSync(descendantRecord));
    const descendantPid = Number(readFileSync(descendantRecord, "utf8"));
    expect(processExists(descendantPid)).toBe(true);
    await controller.close();
    await waitUntil(() => !processExists(descendantPid), 1_000);
    expect(processExists(descendantPid)).toBe(false);
    expect(controller.snapshot()).toMatchObject({ status: "closed", outstandingRequestIds: [] });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
