import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import agentSessionsExtension from "../src/extension/index.js";
import { COLLECTION_FLAG, DEPTH_ENV, HOST_CONFIG_ENV } from "../src/extension/config.js";

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const roots: string[] = [];
const savedHostConfig = process.env[HOST_CONFIG_ENV];
const savedDepth = process.env[DEPTH_ENV];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-extension-"));
  roots.push(root);
  return root;
}

async function makeAgent(root: string, name: string): Promise<void> {
  await mkdir(join(root, name, "_agent"), { recursive: true });
  await writeFile(join(root, name, "_agent", "foundation.md"), `# ${name}\n`);
}

class FakeExtensionApi {
  readonly flags = new Map<string, string | boolean | undefined>();
  readonly tools: Array<any> = [];
  readonly handlers = new Map<string, Array<(event: any, context: ExtensionContext) => unknown>>();
  readonly messages: Array<{ message: any; options: any; parentBusy: boolean }> = [];
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly dialogCalls: Array<{ method: string; title: string }> = [];
  readonly dialogAnswers: unknown[] = [];
  readonly widgetUpdates: Array<{ key: string; lines: string[] | undefined }> = [];
  readonly statusUpdates: Array<{ key: string; text: string | undefined }> = [];
  parentBusy = false;

  registerFlag(name: string, options: { default?: string | boolean }): void {
    if (!this.flags.has(name)) this.flags.set(name, options.default);
  }

  getFlag(name: string): string | boolean | undefined {
    return this.flags.get(name);
  }

  registerTool(tool: any): void {
    this.tools.push(tool);
  }

  on(event: string, handler: (event: any, context: ExtensionContext) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: any, options: any): void {
    this.messages.push({ message, options, parentBusy: this.parentBusy });
  }

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ customType, data });
  }

  async emit(event: string, value: any, context: ExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(value, context);
  }
}

function fakeContext(api: FakeExtensionApi): ExtensionContext {
  return {
    hasUI: true,
    mode: "tui",
    cwd: tempRoot(),
    ui: {
      select(title: string) {
        api.dialogCalls.push({ method: "select", title });
        return Promise.resolve(api.dialogAnswers.shift() as string | undefined);
      },
      confirm(title: string) {
        api.dialogCalls.push({ method: "confirm", title });
        return Promise.resolve(api.dialogAnswers.shift() as boolean ?? false);
      },
      input(title: string) {
        api.dialogCalls.push({ method: "input", title });
        return Promise.resolve(api.dialogAnswers.shift() as string | undefined);
      },
      editor(title: string) {
        api.dialogCalls.push({ method: "editor", title });
        return Promise.resolve(api.dialogAnswers.shift() as string | undefined);
      },
      notify(message: string, type?: string) {
        api.entries.push({ customType: `notify:${type ?? "info"}`, data: message });
      },
      setWidget(key: string, lines: string[] | undefined) {
        api.widgetUpdates.push({ key, lines });
      },
      setStatus(key: string, text: string | undefined) {
        api.statusUpdates.push({ key, text });
      },
    },
    sessionManager: {
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
}

function configure(root: string, scenario: string, extraEnv: Record<string, string> = {}): void {
  process.env[HOST_CONFIG_ENV] = JSON.stringify({
    collectionRoot: root,
    approveProjectResources: true,
    controller: {
      executable: { command: process.execPath, argvPrefix: [fakePi] },
      env: { FAKE_PI_SCENARIO: scenario, ...extraEnv },
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
        maxChildren: 4,
      },
    },
  });
  delete process.env[DEPTH_ENV];
}

afterEach(async () => {
  if (savedHostConfig === undefined) delete process.env[HOST_CONFIG_ENV];
  else process.env[HOST_CONFIG_ENV] = savedHostConfig;
  if (savedDepth === undefined) delete process.env[DEPTH_ENV];
  else process.env[DEPTH_ENV] = savedDepth;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent_session Pi extension", () => {
  it("does not register the tool inside a child session", () => {
    process.env[DEPTH_ENV] = "1";
    delete process.env[HOST_CONFIG_ENV];
    const api = new FakeExtensionApi();
    agentSessionsExtension(api as unknown as ExtensionAPI);
    expect(api.tools).toEqual([]);
  });

  it("resolves extension flag values at session start after Pi applies CLI arguments", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    delete process.env[HOST_CONFIG_ENV];
    delete process.env[DEPTH_ENV];
    const api = new FakeExtensionApi();
    const context = fakeContext(api);
    agentSessionsExtension(api as unknown as ExtensionAPI);
    api.flags.set(COLLECTION_FLAG, root);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const tool = api.tools.find((candidate) => candidate.name === "agent_session");

    const list = await tool.execute("call-1", { action: "list" }, undefined, undefined, context);
    expect(list.content[0].text).toContain("Agents (1): Backend");
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  });

  it("starts background children and delivers exact labelled custom messages while parent busy or idle", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    await makeAgent(root, "Frontend");
    configure(root, "normal");
    const api = new FakeExtensionApi();
    const context = fakeContext(api);
    agentSessionsExtension(api as unknown as ExtensionAPI);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const tool = api.tools.find((candidate) => candidate.name === "agent_session");

    api.parentBusy = true;
    const backend = await tool.execute("call-1", { action: "start", agent: "Backend", message: "one" }, undefined, undefined, context);
    await waitUntil(() => api.messages.length === 1);
    api.parentBusy = false;
    const frontend = await tool.execute("call-2", { action: "start", agent: "Frontend", message: "two" }, undefined, undefined, context);
    await waitUntil(() => api.messages.length === 2);

    expect(backend.content[0].text).toContain("Started Backend");
    expect(frontend.content[0].text).toContain("Started Frontend");
    expect(api.messages.map((item) => item.parentBusy)).toEqual([true, false]);
    for (const delivered of api.messages) {
      expect(delivered.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(delivered.message).toMatchObject({ customType: "agent-session-reply", display: true });
      expect(delivered.message.content).toContain("[Fellow agent reply —");
      expect(delivered.message.content).toContain("Outcome: completed");
    }
    expect(api.entries.filter((entry) => entry.customType === "agent-session-pointer")).toHaveLength(2);

    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
    expect(api.entries.filter((entry) => entry.customType === "agent-session-pointer")).toHaveLength(4);
  });

  it("forwards all supported dialogs through the labelled parent FIFO and updates the terminal widget", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    configure(root, "dialog-all");
    const api = new FakeExtensionApi();
    api.dialogAnswers.push("Beta", false, "Ada", "edited text");
    const context = fakeContext(api);
    agentSessionsExtension(api as unknown as ExtensionAPI);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const tool = api.tools.find((candidate) => candidate.name === "agent_session");

    const started = await tool.execute(
      "call-1",
      { action: "start", agent: "Backend", message: "ask" },
      undefined,
      undefined,
      context,
    );
    await waitUntil(() => api.messages.length === 1);

    expect(started.content[0].text).toContain("Started Backend");
    expect(api.dialogCalls.map((call) => call.method)).toEqual(["select", "confirm", "input", "editor"]);
    expect(api.dialogCalls.every((call) => call.title.includes("Fellow agent: Backend"))).toBe(true);
    expect(api.messages[0].message.content).toContain('"confirmed":false');
    expect(api.widgetUpdates.some((update) => update.lines?.some((line) => line.includes("Backend")))).toBe(true);

    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
    expect(api.widgetUpdates.at(-1)).toEqual({ key: "agent-sessions", lines: undefined });
  });

  it("cancels a forwarded dialog on parent teardown without waiting for late UI", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    const commandRecord = join(root, "commands.jsonl");
    configure(root, "dialog", { FAKE_COMMAND_RECORD: commandRecord });
    const api = new FakeExtensionApi();
    api.dialogAnswers.push(new Promise(() => undefined));
    const context = fakeContext(api);
    agentSessionsExtension(api as unknown as ExtensionAPI);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const tool = api.tools.find((candidate) => candidate.name === "agent_session");

    await tool.execute("call-1", { action: "start", agent: "Backend", message: "ask" }, undefined, undefined, context);
    await waitUntil(() => api.dialogCalls.length === 1);
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);

    const commands = (await readFile(commandRecord, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands).toContainEqual({ type: "extension_ui_response", id: "dialog-1", cancelled: true });
  });

  it("holds a reply after branch movement and retrieves it through status", async () => {
    const root = tempRoot();
    await makeAgent(root, "Backend");
    configure(root, "hold");
    const api = new FakeExtensionApi();
    const context = fakeContext(api);
    agentSessionsExtension(api as unknown as ExtensionAPI);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const tool = api.tools.find((candidate) => candidate.name === "agent_session");
    const started = await tool.execute("call-1", { action: "start", agent: "Backend", message: "work" }, undefined, undefined, context);
    const runId = started.details.operation.run.session.runId as string;

    await api.emit("session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: "new" }, context);
    await tool.execute("call-2", { action: "interrupt", runId }, undefined, undefined, context);
    await waitUntil(() => api.entries.some((entry) => entry.customType === "notify:warning"));

    expect(api.messages).toEqual([]);
    const status = await tool.execute("call-3", { action: "status", runId }, undefined, undefined, context);
    expect(status.content[0].text).toContain("Unread replies (1)");
    expect(status.content[0].text).toContain("Outcome: interrupted");
    const reread = await tool.execute("call-4", { action: "status", runId }, undefined, undefined, context);
    expect(reread.content[0].text).not.toContain("Unread replies");

    await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
