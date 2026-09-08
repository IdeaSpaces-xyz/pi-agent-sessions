import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PersistentRpcController } from "../src/controller/controller.js";
import type { ChildDialogRequest } from "../src/controller/types.js";

const enabled = process.env.PI_AGENT_SESSIONS_REAL_TURN_SMOKE === "1";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real Pi fellow-agent turn smoke", () => {
  it("keeps one oriented child through dialogs, follow-up, interruption, and close", async () => {
    const collection = mkdtempSync(join(tmpdir(), "pi-agent-turn-smoke-"));
    roots.push(collection);
    const target = join(collection, "FixtureAgent");
    const agent = join(target, "_agent");
    const extensions = join(target, ".pi", "extensions");
    await mkdir(agent, { recursive: true });
    await mkdir(extensions, { recursive: true });
    writeFileSync(join(agent, "foundation.md"), "# Foundation\n\nYou are the generic fixture agent.\n");
    writeFileSync(join(agent, "guide.md"), "# Guide\n\nAnswer directly and follow smoke instructions exactly.\n");
    writeFileSync(join(agent, "purpose.md"), "# Purpose\n\nProve isolated persistent sessions.\n");
    writeFileSync(join(agent, "now.md"), "# Now\n\nP3-DIALOG-SMOKE\n");
    writeFileSync(join(agent, "next.md"), "# Next\n\nClose cleanly.\n");
    writeFileSync(join(extensions, "p3-smoke.ts"), smokeExtension());

    const controller = await PersistentRpcController.start({
      target,
      trust: { mode: "explicit" },
      executable: { command: "pi" },
      model: process.env.PI_AGENT_SESSIONS_REAL_MODEL,
      limits: {
        startupTimeoutMs: 30_000,
        requestTimeoutMs: 30_000,
        settlementTimeoutMs: 180_000,
        dialogTimeoutMs: 30_000,
      },
    });
    const initial = controller.snapshot();
    const dialogs: ChildDialogRequest[] = [];
    const stopUi = controller.onUiEvent((event) => {
      if (event.type !== "request") return;
      const request = event.request;
      if (request.method !== "select" && request.method !== "confirm" && request.method !== "input" && request.method !== "editor") return;
      dialogs.push(request);
      const response =
        request.method === "select" ? { value: "Alpha" } as const :
        request.method === "confirm" ? { confirmed: true } as const :
        request.method === "input" ? { value: "Ada" } as const :
        { value: "edited text" } as const;
      void controller.respondToDialog(request.id, response);
    });

    try {
      const first = await controller.promptAndWait(
        "Call p3_dialog_smoke exactly once. Then report the exact marker from _agent/now.md and your current working directory.",
      );
      expect(first.status, first.error).toBe("completed");
      expect(first.reply).toContain("P3-DIALOG-SMOKE");
      expect(first.reply).toContain(target);
      expect(dialogs.map((dialog) => dialog.method)).toEqual(["select", "confirm", "input", "editor"]);

      const afterFirst = controller.snapshot();
      const second = await controller.promptAndWait("Reply with exactly: follow-up-ok");
      expect(second).toMatchObject({ status: "completed" });
      expect(second.reply?.toLowerCase()).toContain("follow-up-ok");
      expect(controller.snapshot()).toMatchObject({ pid: initial.pid, sessionId: initial.sessionId });
      expect(afterFirst.pid).toBe(initial.pid);

      const interruptId = await controller.prompt("Call p3_wait exactly once and wait for it to finish.");
      await waitUntil(() => controller.snapshot().activeTools.some((tool) => tool.toolName === "p3_wait"), 120_000);
      const interrupted = await controller.interrupt();
      expect(interrupted).toMatchObject({ operationId: interruptId, status: "interrupted" });
    } finally {
      stopUi();
      await controller.close();
    }
    expect(controller.snapshot()).toMatchObject({ status: "closed", outstandingDialogs: [] });
  }, 360_000);
});

function smokeExtension(): string {
  return `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "p3_dialog_smoke",
    label: "P3 Dialog Smoke",
    description: "Exercise all four supported human dialog methods exactly once.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const selected = await ctx.ui.select("Choose", ["Alpha", "Beta"], { signal, timeout: 30000 });
      const confirmed = await ctx.ui.confirm("Proceed?", "Continue", { signal, timeout: 30000 });
      const input = await ctx.ui.input("Name", "value", { signal, timeout: 30000 });
      const edited = await ctx.ui.editor("Draft", "starting text");
      return {
        content: [{ type: "text", text: JSON.stringify({ selected, confirmed, input, edited, cwd: process.cwd() }) }],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "p3_wait",
    label: "P3 Wait",
    description: "Wait until the current turn is interrupted.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 60000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      return { content: [{ type: "text", text: "wait ended" }], details: {} };
    },
  });
}
`;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
