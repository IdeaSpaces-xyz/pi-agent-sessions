import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgentController } from "../src/controller/cli-controller.js";

const roots: string[] = [];
let pov: string;
let cli: string;
const ALL_FEATURES = ["pi.explicit-extensions", "pi.skill-isolation", "pi.trust", "pi.thinking",
  "claude.read-only", "claude.effort", "claude.permission-mode", "model.requested-observed"];

/** A stand-in CLI whose only behaviour is its answer to `--json agent capabilities`. */
function capabilitiesCli(name: string, stdout: string, code = 0): string {
  const path = join(pov, `${name}.cjs`);
  writeFileSync(path, `process.stdout.write(${JSON.stringify(stdout)}); process.exit(${code});\n`);
  return path;
}
function capabilities(features: string[]): string {
  return JSON.stringify({ schema: "ideaspaces.agent-run.capabilities", version: 1, features });
}

beforeEach(() => {
  pov = mkdtempSync(join(tmpdir(), "fellow-pov-"));
  roots.push(pov);
  mkdirSync(join(pov, "_agent"));
  writeFileSync(join(pov, "_agent", "agreement.md"), "# Agreement\n");
  cli = join(pov, "fake-cli.cjs");
  writeFileSync(cli, `
const fs=require('node:fs'),path=require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') === '--json agent capabilities') {
  console.log(JSON.stringify({schema:'ideaspaces.agent-run.capabilities',version:1,features:${JSON.stringify(ALL_FEATURES)}},null,2));
  process.exit(0);
}
fs.appendFileSync(path.join(__dirname,'argv.jsonl'),JSON.stringify(args)+'\\n');
if (!args.includes('--json')) process.exit(2);
if (args.includes('--message=fail')) {
  console.log(JSON.stringify({type:'error', message:'Failed to authenticate'}));
  process.exit(1);
}
if (args.includes('--message=hang')) {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 100);
} else if (args.includes('--message=hang-after-start')) {
  const id=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:'44444444-4444-4444-8444-444444444444';
  fs.writeFileSync(path.join(__dirname,'transcript.jsonl'), JSON.stringify({type:'session',id})+'\\n');
  console.log(JSON.stringify({type:'message_start', conversation_id:id, model_observed:'fake-model'}));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 100);
} else {
  const id=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:(args.includes('--ext')?'local-first':'44444444-4444-4444-8444-444444444444');
  const message=(args.find((arg)=>arg.startsWith('--message='))||'').slice(10);
  const observed=message.startsWith('model:')?(message.slice(6)==='none'?null:message.slice(6)):'fake-observed';
  console.log(JSON.stringify({type:'message_start', conversation_id:id, model_observed:observed}));
  console.log(JSON.stringify({type:'text_delta', delta:'reply'}));
  console.log(JSON.stringify({type:'turn_complete', result:{response:'reply'}}));
}
`);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function create(runtime: "pi" | "claude" = "claude", extras: Record<string, unknown> = {}) {
  return new CliAgentController({ target: pov, runtime, cliPath: cli, ...extras });
}

describe("CLI fellow controller", () => {
  it("launches an Agreement path under Claude, reports bounded reply, then sends again on same id", async () => {
    const controller = create("claude", { model: "sonnet", permissionMode: "manual" });
    const replies: string[] = [];
    controller.onTurnSettled((turn) => replies.push(turn.reply ?? ""));
    const first = await controller.prompt("first");
    expect((await controller.waitForTurn(first)).status).toBe("completed");
    const second = await controller.prompt("again");
    expect((await controller.waitForTurn(second)).reply).toBe("reply");
    const argv=readFileSync(join(pov,"argv.jsonl"),"utf8").trim().split("\n").map((line)=>JSON.parse(line) as string[]);
    expect(argv[0]).not.toContain("--conversation");
    expect(argv[1]).toEqual(expect.arrayContaining(["--conversation",controller.conversationId]));
    expect(controller.snapshot()).toMatchObject({ runtime: "claude", model: "sonnet", status: "idle", sessionId: controller.conversationId });
    expect(replies).toEqual(["reply", "reply"]);
  });

  it("forwards Pi thinking while preserving the same conversation id", async () => {
    const controller = create("pi", { model: "openai/gpt-5", thinking: "high", extensionPaths: [cli], skillPaths: [join(pov,"_agent")] });
    const op = await controller.prompt("first");
    expect((await controller.waitForTurn(op)).status).toBe("completed");
    expect(controller.snapshot()).toMatchObject({ runtime: "pi", thinking: "high", sessionId: "local-first" });
    const argv=JSON.parse(readFileSync(join(pov,"argv.jsonl"),"utf8").trim()) as string[];
    expect(argv).toEqual(expect.arrayContaining(["--ext",cli,"--skill",join(pov,"_agent")]));
    expect(argv).not.toContain("--conversation");
  });

  it("reports auth failure as a failed turn rather than success", async () => {
    const controller = create();
    const op = await controller.prompt("fail");
    expect(await controller.waitForTurn(op)).toMatchObject({ status: "failed", error: "Failed to authenticate" });
  });

  it("interrupts and closes the process tree without reporting success", async () => {
    const controller = create();
    const op = await controller.prompt("hang");
    expect((await controller.interrupt())?.status).toBe("interrupted");
    expect((await controller.waitForTurn(op)).status).toBe("interrupted");
    await controller.close();
    expect(controller.snapshot().status).toBe("closed");
  });

  it("refuses a replaced Agreement before spawning the next turn", async () => {
    const controller = create();
    renameSync(join(pov, "_agent", "agreement.md"), join(pov, "_agent", "old.md"));
    writeFileSync(join(pov, "_agent", "agreement.md"), "# Replacement\n");
    await expect(controller.prompt("hello")).rejects.toThrow("changed before launch");
  });

  it("launches Pi and Claude when the CLI reports the capabilities, whatever its help says", async () => {
    // The 0.2.16 regression: help no longer carried a sentence the probe searched for.
    const pi = await CliAgentController.start({ target: pov, runtime: "pi", extensionPaths: [cli], thinking: "high", cliPath: cli });
    expect((await pi.waitForTurn(await pi.prompt("first"))).status).toBe("completed");
    const claude = await CliAgentController.start({ target: pov, runtime: "claude", effort: "high", cliPath: cli });
    expect((await claude.waitForTurn(await claude.prompt("first"))).status).toBe("completed");
    const argv = readFileSync(join(pov, "argv.jsonl"), "utf8");
    expect(argv).not.toContain("--help");
  });

  it("refuses a CLI that has no capabilities command, even if its help names every flag", async () => {
    const old = capabilitiesCli("old-cli", "Usage: ideaspaces agent <run|list> --pi-trust --ext --skill skill discovery is disabled\n", 1);
    await expect(CliAgentController.start({ target: pov, runtime: "pi", extensionPaths: [cli], cliPath: old }))
      .rejects.toThrow(/does not report agent-run capabilities; update @ideaspaces\/cli to 0\.2\.17/);
    await expect(CliAgentController.start({ target: pov, runtime: "claude", cliPath: old }))
      .rejects.toThrow("does not report agent-run capabilities");
  });

  it("refuses an unparseable or foreign capabilities document", async () => {
    for (const [name, out] of [["prose", "pi.skill-isolation\n"], ["foreign", JSON.stringify({ schema: "other", version: 1, features: ALL_FEATURES })],
      ["unversioned", JSON.stringify({ schema: "ideaspaces.agent-run.capabilities", features: ALL_FEATURES })]] as const) {
      await expect(CliAgentController.start({ target: pov, runtime: "pi", extensionPaths: [cli], cliPath: capabilitiesCli(name, out) }))
        .rejects.toThrow("does not report agent-run capabilities");
    }
  });

  it("names each missing guarantee and refuses before any child starts", async () => {
    const noIsolation = capabilitiesCli("no-isolation", capabilities(ALL_FEATURES.filter((f) => f !== "pi.skill-isolation")));
    await expect(CliAgentController.start({ target: pov, runtime: "pi", extensionPaths: [cli], cliPath: noIsolation }))
      .rejects.toThrow(/does not guarantee pi\.skill-isolation for pi launches/);
    const noReadOnly = capabilitiesCli("no-read-only", capabilities(ALL_FEATURES.filter((f) => f !== "claude.read-only")));
    await expect(CliAgentController.start({ target: pov, runtime: "claude", cliPath: noReadOnly }))
      .rejects.toThrow("claude.read-only");
    // Writable Claude does not need the read-only guarantee; an unrequested effort level is not required either.
    const minimal = capabilitiesCli("minimal", capabilities(["claude.permission-mode"]));
    await expect(CliAgentController.start({ target: pov, runtime: "claude", readOnly: false, cliPath: minimal })).resolves.toBeDefined();
    await expect(CliAgentController.start({ target: pov, runtime: "claude", readOnly: false, effort: "high", cliPath: minimal }))
      .rejects.toThrow("claude.effort");
  });

  it("says plainly when the CLI cannot be run at all", async () => {
    await expect(CliAgentController.start({ target: pov, runtime: "pi", extensionPaths: [cli], cliPath: join(pov, "no-such-ideaspaces") }))
      .rejects.toThrow(/Could not run the IdeaSpaces CLI .*IS_CLI_PATH/);
  });

  it("keeps the requested model apart from the observed one, per turn", async () => {
    const controller = create("pi", { model: "openai/gpt-5", extensionPaths: [cli] });
    expect(controller.snapshot()).toMatchObject({ model: "openai/gpt-5" });
    expect(controller.snapshot().observedModel).toBeUndefined();
    await controller.waitForTurn(await controller.prompt("model:provider/first"));
    expect(controller.snapshot()).toMatchObject({ model: "openai/gpt-5", observedModel: "provider/first" });
    await controller.waitForTurn(await controller.prompt("model:provider/second"));
    expect(controller.snapshot().observedModel).toBe("provider/second");
    // A turn whose runtime reported nothing does not inherit the previous turn's model.
    await controller.waitForTurn(await controller.prompt("model:none"));
    expect(controller.snapshot().observedModel).toBeUndefined();
    await controller.waitForTurn(await controller.prompt("model:bad\u001b[2Jmodel"));
    expect(controller.snapshot().observedModel).toBeUndefined();
  });

  it("does not time out a default run at 600s", async () => {
    vi.useFakeTimers();
    try {
      const controller = create();
      const op = await controller.prompt("hang");
      // Advance timers well past the old 600s (10 min) standing deadline
      await vi.advanceTimersByTimeAsync(650_000);
      const snapshot = controller.snapshot();
      const turn = snapshot.turns.find((t) => t.operationId === op);
      expect(turn?.status).toBe("running");
      expect(snapshot.status).toBe("running");
      // Settle cleanly with interrupt
      await controller.interrupt();
      expect((await controller.waitForTurn(op)).status).toBe("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a hanging run when explicit ceiling is supplied via limits or per-turn options", async () => {
    const limitedController = create("claude", { limits: { settlementTimeoutMs: 50 } });
    const op1 = await limitedController.prompt("hang");
    const turn1 = await limitedController.waitForTurn(op1);
    expect(turn1).toMatchObject({ status: "failed", error: "CLI turn timed out after 50ms" });
    await limitedController.close();

    const perTurnController = create();
    const op2 = await perTurnController.prompt("hang", { timeoutMs: 60 });
    const turn2 = await perTurnController.waitForTurn(op2);
    expect(turn2).toMatchObject({ status: "failed", error: "CLI turn timed out after 60ms" });
    await perTurnController.close();
  });

  it("interrupts an unlimited run cleanly and preserves conversation id for subsequent resume/prompt", async () => {
    const controller = create();
    const op1 = await controller.prompt("hang-after-start");
    // Wait for message_start to be received
    await waitUntil(() => controller.conversationId === "44444444-4444-4444-8444-444444444444");
    expect(controller.snapshot().sessionId).toBe("44444444-4444-4444-8444-444444444444");

    const interrupted = await controller.interrupt();
    expect(interrupted?.status).toBe("interrupted");
    expect((await controller.waitForTurn(op1)).status).toBe("interrupted");
    expect(controller.snapshot().status).toBe("idle");
    expect(controller.conversationId).toBe("44444444-4444-4444-8444-444444444444");
    expect(readFileSync(join(pov, "transcript.jsonl"), "utf8")).toContain(controller.conversationId);

    // Next turn should resume on the same conversation id and complete
    const op2 = await controller.prompt("second");
    const turn2 = await controller.waitForTurn(op2);
    expect(turn2.status).toBe("completed");
    expect(turn2.reply).toBe("reply");
    const argv = readFileSync(join(pov, "argv.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv[1]).toEqual(expect.arrayContaining(["--conversation", "44444444-4444-4444-8444-444444444444"]));
    await controller.close();
  });

  it("rejects missing Agreement and invalid Claude conversation id before spawn", () => {
    expect(() => create("claude", { resumeConversationId: "typo" })).toThrow("UUID");
    rmSync(join(pov, "_agent", "agreement.md"));
    expect(() => create()).toThrow();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
