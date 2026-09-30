import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgentController } from "../src/controller/cli-controller.js";

const roots: string[] = [];
let pov: string;
let cli: string;

beforeEach(() => {
  pov = mkdtempSync(join(tmpdir(), "fellow-pov-"));
  roots.push(pov);
  mkdirSync(join(pov, "_agent"));
  writeFileSync(join(pov, "_agent", "agreement.md"), "# Agreement\n");
  cli = join(pov, "fake-cli.cjs");
  writeFileSync(cli, `
const fs=require('node:fs'),path=require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'argv.jsonl'),JSON.stringify(args)+'\\n');
if (!args.includes('--json')) process.exit(2);
if (args.includes('--message=fail')) {
  console.log(JSON.stringify({type:'error', message:'Failed to authenticate'}));
  process.exit(1);
}
if (args.includes('--message=hang')) {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 100);
} else {
  const id=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:(args.includes('--ext')?'local-first':'44444444-4444-4444-8444-444444444444');
  console.log(JSON.stringify({type:'message_start', conversation_id:id}));
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

  it("refuses older CLI help that cannot suppress discovered child skills", async () => {
    const old = join(pov, "old-cli.cjs");
    writeFileSync(old, "process.stderr.write('--pi-trust --ext --skill\\n');\n");
    await expect(CliAgentController.start({ target: pov, runtime: "pi", extensionPaths: [cli], cliPath: old }))
      .rejects.toThrow("skill isolation");
  });

  it("rejects missing Agreement and invalid Claude conversation id before spawn", () => {
    expect(() => create("claude", { resumeConversationId: "typo" })).toThrow("UUID");
    rmSync(join(pov, "_agent", "agreement.md"));
    expect(() => create()).toThrow();
  });
});
