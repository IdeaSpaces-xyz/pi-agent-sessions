import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
      startupTimeoutMs: 300,
      requestTimeoutMs: 300,
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
      env: { FAKE_PI_RECORD: record, FAKE_CUSTOM: "forwarded", PI_SESSION_ID: undefined },
    });
    const invocation = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    expect(invocation).toMatchObject({
      cwd: controller.snapshot().cwd,
      depth: "1",
      custom: "forwarded",
      argv: ["--mode", "rpc", "--model", "provider/model", "--thinking", "high", "--approve"],
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

  it("keeps one process for repeated prompts and separates process state from outcomes", async () => {
    const controller = await start();
    const pid = controller.snapshot().pid;
    const first = await controller.promptAndWait("first");
    const second = await controller.promptAndWait("second");
    expect(first).toMatchObject({ status: "completed", reply: "reply 1: first", stopReason: "stop" });
    expect(second).toMatchObject({ status: "completed", reply: "reply 2: second", stopReason: "stop" });
    expect(second.operationId).not.toBe(first.operationId);
    expect(controller.snapshot()).toMatchObject({ pid, status: "idle", activeTools: [], outstandingRequestIds: [] });
  });

  it("waits through retry progress until agent_settled", async () => {
    const controller = await start("retry");
    const turn = await controller.promptAndWait("retry me");
    expect(turn).toMatchObject({ status: "completed", reply: "after retry" });
    expect(controller.snapshot().recentEvents.map((event) => event.type)).toContain("auto_retry_start");
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

  it("tracks human dialogs and cancels them when closing", async () => {
    const target = tempRoot();
    const record = join(target, "dialog.jsonl");
    const controller = await start("dialog", { target, env: { FAKE_PI_RECORD: record } });
    await controller.prompt("ask");
    await waitUntil(() => controller.snapshot().outstandingDialogs.length === 1);
    expect(controller.snapshot().status).toBe("waiting_for_input");
    await controller.close();
    const lines = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ type: "extension_ui_response", id: "dialog-1", cancelled: true });
    expect(controller.snapshot()).toMatchObject({ status: "closed", outstandingDialogs: [], outstandingRequestIds: [] });
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
      limits: { closeGraceMs: 30, killGraceMs: 100 },
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
