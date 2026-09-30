import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { StrictJsonlDecoder } from "../src/controller/jsonl.js";

const enabled = process.env.PI_AGENT_SESSIONS_REAL_PARENT_SMOKE === "1";
const packageRoot = process.env.PI_AGENT_SESSIONS_PACKAGE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.env.PI_AGENT_SESSIONS_REAL_MODEL ?? "openai-codex/gpt-5.5";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real parent Pi extension smoke", () => {
  it("forwards child dialogs and automatically delivers repeated replies", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-parent-smoke-"));
    roots.push(root);
    const parent = join(root, "parent");
    const collection = join(root, "agents");
    const target = join(collection, "FixtureAgent");
    const agent = join(target, "_agent");
    const smoke = join(root, "p3-smoke.ts");
    await mkdir(parent, { recursive: true });
    await mkdir(agent, { recursive: true });
    writeFileSync(join(agent, "foundation.md"), "# Foundation\n\nYou are FixtureAgent.\n");
    writeFileSync(join(agent, "guide.md"), "# Guide\n\nFollow smoke prompts exactly.\n");
    writeFileSync(join(agent, "purpose.md"), "# Purpose\n\nProve child isolation.\n");
    writeFileSync(join(agent, "now.md"), "# Now\n\nPARENT-E2E-NOW\n");
    writeFileSync(join(agent, "next.md"), "# Next\n\nClose cleanly.\n");
    writeFileSync(smoke, dialogSmokeExtension());

    const config = {
      collectionRoot: collection,
      approveProjectResources: true,
      controller: {
        executable: { command: "pi" },
        extensionPaths: [smoke],
        limits: {
          startupTimeoutMs: 30_000,
          requestTimeoutMs: 30_000,
          settlementTimeoutMs: 180_000,
          dialogTimeoutMs: 30_000,
        },
      },
    };
    const rpc = new ParentRpcHarness(
      spawn(
        "pi",
        [
          "--mode", "rpc",
          "--approve",
          "--no-extensions",
          "--extension", join(packageRoot, "src", "index.ts"),
          "--model", model,
        ],
        {
          cwd: parent,
          env: { ...process.env, PI_AGENT_SESSIONS_CONFIG: JSON.stringify(config) },
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );

    try {
      rpc.send({ id: "ready", type: "get_state" });
      await rpc.waitFor(
        () => rpc.events.some((event) => event.type === "response" && event.command === "get_state" && event.success),
        "parent readiness",
        30_000,
      );
      rpc.send({
        id: "start",
        type: "prompt",
        message:
          `Call agent_session start exactly once for agent FixtureAgent using model ${model}. ` +
          "Give it this exact message: Call p3_dialog_smoke exactly once, then call read exactly once on _agent/now.md and reply with " +
          "CHILD-P3-DONE, the exact marker, and your exact current working directory. Do not call any other tool.",
      });
      await rpc.waitFor(() => rpc.runId !== undefined, "owned run id");
      await rpc.waitFor(() => rpc.dialogs.length === 4, "four forwarded dialogs");
      expect(rpc.dialogs).toEqual(["select", "confirm", "input", "editor"]);
      await rpc.waitFor(
        () => rpc.fellowReplies.some((text) => text.includes("CHILD-P3-DONE") && text.includes("PARENT-E2E-NOW") && text.includes(realpathSync(target))),
        "automatic child reply",
      );
      await rpc.waitFor(() => rpc.assistantTexts.length >= 3, "parent relay");
      await rpc.waitForIdle("parent relay settlement");

      const assistantCountBeforeFollowUp = rpc.assistantTexts.length;
      rpc.send({
        id: "follow-up",
        type: "prompt",
        message:
          `Call agent_session send exactly once for runId ${rpc.runId}. ` +
          "Send this exact message: Reply exactly CHILD-FOLLOW-UP-OK. Do not call any other tool.",
      });
      await rpc.waitFor(() => rpc.fellowReplies.some((text) => text.includes("CHILD-FOLLOW-UP-OK")), "follow-up reply");
      await rpc.waitFor(() => rpc.assistantTexts.length > assistantCountBeforeFollowUp, "follow-up relay");
      await rpc.waitForIdle("follow-up relay settlement");

      rpc.send({
        id: "close",
        type: "prompt",
        message: `Call agent_session close exactly once for runId ${rpc.runId}. Do not call any other tool.`,
      });
      await rpc.waitFor(
        () => rpc.events.some((event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "agent_session" &&
          event.result?.details?.run?.session?.status === "closed"),
        "explicit child close",
      );
    } finally {
      await rpc.close();
    }
  }, 360_000);
});

describe.skipIf(process.env.PI_AGENT_SESSIONS_REAL_CLI_SMOKE !== "1")("real parent → CLI-backed Pi child", () => {
  it("inherits active parent connectors, observes a real child tool, and follows up on the exact id", async () => {
    const cli = process.env.IS_CLI_PATH;
    if (!cli) throw new Error("Set IS_CLI_PATH to the installed CLI 0.2.0+ bundle for this real smoke.");
    const connectors = process.env.PI_AGENT_SESSIONS_CONNECTORS;
    if (!connectors) throw new Error("Set PI_AGENT_SESSIONS_CONNECTORS to two reviewed installed Pi package roots, separated by a comma.");
    const [space, context] = connectors.split(",");
    if (!space || !context) throw new Error("Two connector roots are required.");
    const root = mkdtempSync(join(tmpdir(), "pi-fellow-cli-smoke-")); roots.push(root);
    const parent = join(root, "parent");
    const target = join(root, "external-fellow");
    await mkdir(parent, { recursive: true });
    await mkdir(join(target, "_agent"), { recursive: true });
    writeFileSync(join(target, "_agent", "agreement.md"), "---\nname: Fellow\n---\n# Fellow\nReply briefly.\n");
    const init = spawnSync("git", ["init", "-q"], { cwd: target, encoding: "utf8" });
    if (init.status !== 0) throw new Error(init.stderr);
    const env = { ...process.env, PI_AGENT_SESSIONS_DEPTH: undefined, PI_AGENT_SESSION_DEPTH: undefined,
      IDEASPACES_PI_EXTENSIONS: undefined, IDEASPACES_PI_SKILLS: undefined };
    const rpc = new ParentRpcHarness(spawn("pi", [
      "--mode", "rpc", "--no-extensions", "--no-skills", "--no-approve",
      "--extension", join(packageRoot, "dist", "index.js"),
      "--extension", join(space, "src", "index.ts"), "--extension", join(context, "src", "index.ts"),
      "--skill", join(space, "skills"), "--skill", join(context, "skills"),
      "--model", model,
    ], { cwd: parent, env, stdio: ["pipe", "pipe", "pipe"] }));
    try {
      rpc.send({ id: "ready", type: "get_state" });
      await rpc.waitFor(() => rpc.events.some((event) => event.type === "response" && event.id === "ready" && event.success), "parent ready", 30_000);
      rpc.send({ id: "start", type: "prompt", message: `Call agent_session start exactly once with agent ${target}, runtime pi, and message 'Call is_status exactly once, then reply CHILD_TOOL_OK.' Do not call other tools.` });
      await rpc.waitFor(() => !!rpc.runId, "owned run id", 45_000);
      await rpc.waitFor(() => rpc.fellowReplies.some((text) => text.includes("CHILD_TOOL_OK")), "child tool response");
      const sessionsDir = join(target, ".pi", "sessions");
      const transcript = readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"))
        .map((file) => readFileSync(join(sessionsDir, file), "utf8")).join("\n");
      expect(transcript).toContain('"name":"is_status"');
      expect(transcript).toContain('"toolName":"is_status"');
      await rpc.waitForIdle("parent child reply");
      rpc.send({ id: "follow", type: "prompt", message: `Call agent_session send exactly once for runId ${rpc.runId} with message 'Reply SECOND_OK.' Do not call other tools.` });
      await rpc.waitFor(() => rpc.fellowReplies.some((text) => text.includes("SECOND_OK")), "same-id child follow-up");
      expect(readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
      await rpc.waitForIdle("Pi follow-up settled");
      rpc.send({ id: "claude", type: "prompt", message: `Call agent_session start exactly once with agent ${target}, runtime claude, and message 'Reply CLAUDE_CHILD_OK.' Do not call other tools.` });
      await rpc.waitFor(() => rpc.fellowReplies.some((text) => text.includes("CLAUDE_CHILD_OK")), "real Claude fellow reply");
    } finally { await rpc.close(); }
  }, 360_000);
});

class ParentRpcHarness {
  readonly events: any[] = [];
  readonly assistantTexts: string[] = [];
  readonly fellowReplies: string[] = [];
  readonly dialogs: string[] = [];
  runId: string | undefined;
  private stateSequence = 0;
  private readonly waiters = new Set<{ predicate: () => boolean; resolve: () => void }>();
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const decoder = new StrictJsonlDecoder(16 * 1024 * 1024, (record) => this.handle(record as any));
    child.stdout.on("data", (chunk) => decoder.push(chunk));
    child.stdout.on("end", () => decoder.end());
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
  }

  send(value: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async waitFor(predicate: () => boolean, label: string, timeoutMs = 180_000): Promise<void> {
    if (predicate()) return;
    let waiter: { predicate: () => boolean; resolve: () => void } | undefined;
    const reached = new Promise<void>((resolve) => {
      waiter = { predicate, resolve };
      this.waiters.add(waiter);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        reached,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}. Stderr: ${this.stderr}. Assistants: ${JSON.stringify(this.assistantTexts)}. Fellow replies: ${JSON.stringify(this.fellowReplies)}. Events: ${JSON.stringify(this.events.slice(-16).map((e) => ({ type: e.type, toolName: e.toolName, error: e.error, role: e.message?.role, stopReason: e.message?.stopReason, content: JSON.stringify(e.message?.content)?.slice(0, 350), result: e.result?.content?.[0]?.text?.slice(0, 200) })))}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (waiter) this.waiters.delete(waiter);
    }
  }

  async waitForIdle(label: string, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = `idle-${++this.stateSequence}`;
      this.send({ id, type: "get_state" });
      await this.waitFor(
        () => this.events.some((event) => event.type === "response" && event.id === id),
        label,
        Math.max(1, deadline - Date.now()),
      );
      const state = this.events.find((event) => event.type === "response" && event.id === id);
      if (state?.success === true && state.data?.isStreaming === false) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.child.kill("SIGKILL");
            resolve();
          }, 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handle(event: any): void {
    this.events.push(event);
    if (event.type === "extension_ui_request") {
      this.dialogs.push(event.method);
      if (event.method === "select") this.send({ type: "extension_ui_response", id: event.id, value: "Alpha" });
      else if (event.method === "confirm") this.send({ type: "extension_ui_response", id: event.id, confirmed: true });
      else if (event.method === "input") this.send({ type: "extension_ui_response", id: event.id, value: "Ada" });
      else if (event.method === "editor") this.send({ type: "extension_ui_response", id: event.id, value: "edited text" });
    }
    if (event.type === "tool_execution_end" && event.toolName === "agent_session") {
      this.runId ??= event.result?.details?.operation?.run?.session?.runId;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.assistantTexts.push(assistantText(event.message.content));
    }
    if (
      event.type === "message_end" &&
      event.message?.role === "custom" &&
      event.message?.customType === "agent-session-reply"
    ) {
      this.fellowReplies.push(assistantText(event.message.content));
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate()) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function dialogSmokeExtension(): string {
  return `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "p3_dialog_smoke",
    label: "Dialog smoke",
    description: "Ask all four supported dialogs exactly once.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const select = await ctx.ui.select("Choose", ["Alpha", "Beta"], { signal, timeout: 30000 });
      const confirm = await ctx.ui.confirm("Proceed?", "Continue", { signal, timeout: 30000 });
      const input = await ctx.ui.input("Name", "value", { signal, timeout: 30000 });
      const editor = await ctx.ui.editor("Draft", "starting text");
      return {
        content: [{ type: "text", text: JSON.stringify({ select, confirm, input, editor, cwd: process.cwd() }) }],
        details: {},
      };
    },
  });
}
`;
}
