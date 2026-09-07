import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PersistentRpcController } from "../src/controller/controller.js";

const enabled = process.env.PI_AGENT_SESSIONS_REAL_SMOKE === "1";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("installed Pi smoke", () => {
  it("starts the real binary, completes get_state, and closes cleanly", async () => {
    const target = mkdtempSync(join(tmpdir(), "pi-agent-real-smoke-"));
    roots.push(target);
    const controller = await PersistentRpcController.start({
      target,
      trust: { mode: "saved" },
      executable: { command: "pi" },
      env: { PI_OFFLINE: "1" },
      limits: { startupTimeoutMs: 30_000 },
    });
    try {
      expect(controller.snapshot()).toMatchObject({ status: "idle" });
      expect(controller.snapshot().cwd).toBeTruthy();
      expect(controller.snapshot().sessionId).toBeTruthy();
    } finally {
      await controller.close();
    }
    expect(controller.snapshot()).toMatchObject({ status: "closed", outstandingRequestIds: [] });
  });
});
