import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PersistentRpcController } from "../src/controller/controller.js";
import { listAgentConversations, resolveAgentConversation } from "../src/conversations/catalog.js";

const enabled = process.env.PI_AGENT_SESSIONS_REAL_CONVERSATION_SMOKE === "1";
const roots: string[] = [];

const model = process.env.PI_AGENT_SESSIONS_REAL_MODEL;

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real durable fellow-agent conversation smoke", () => {
  it("finds and resumes one conversation in a new process", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-conversation-smoke-"));
    roots.push(root);
    const target = join(root, "FixtureAgent");
    const sessionDir = join(root, "sessions");
    await mkdir(join(target, "_agent"), { recursive: true });
    await mkdir(sessionDir);
    const environment = { PI_CODING_AGENT_SESSION_DIR: sessionDir };

    const first = await PersistentRpcController.start({
      target,
      trust: { mode: "explicit" },
      executable: { command: "pi" },
      model,
      sessionName: "Durable conversation smoke",
      env: environment,
      limits: { startupTimeoutMs: 30_000, requestTimeoutMs: 30_000, settlementTimeoutMs: 180_000 },
    });
    const firstPid = first.snapshot().pid;
    try {
      const turn = await first.promptAndWait(
        "Remember the exact marker DURABLE-CONVERSATION-7429 and reply exactly INITIAL-SAVED.",
      );
      expect(turn).toMatchObject({ status: "completed" });
      expect(turn.reply).toContain("INITIAL-SAVED");
    } finally {
      await first.close();
    }
    const firstState = first.snapshot();
    expect(firstState.sessionId).toBeTruthy();

    const catalog = listAgentConversations("FixtureAgent", target, {
      env: environment,
      query: "durable conversation smoke",
    });
    expect(catalog.conversations).toEqual([
      expect.objectContaining({ conversationId: firstState.sessionId, name: "Durable conversation smoke" }),
    ]);
    const selected = resolveAgentConversation(target, firstState.sessionId!, { env: environment });

    const resumed = await PersistentRpcController.start({
      target,
      trust: { mode: "explicit" },
      executable: { command: "pi" },
      model,
      resumeSession: { path: selected.path, conversationId: firstState.sessionId! },
      env: environment,
      limits: { startupTimeoutMs: 30_000, requestTimeoutMs: 30_000, settlementTimeoutMs: 180_000 },
    });
    try {
      expect(resumed.snapshot().sessionId).toBe(firstState.sessionId);
      expect(resumed.snapshot().pid).not.toBe(firstPid);
      const turn = await resumed.promptAndWait("What exact marker did I ask you to remember? Reply with only that marker.");
      expect(turn).toMatchObject({ status: "completed" });
      expect(turn.reply).toContain("DURABLE-CONVERSATION-7429");
    } finally {
      await resumed.close();
    }
  }, 360_000);
});
