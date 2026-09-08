import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PersistentRpcController } from "../src/controller/controller.js";

const enabled = process.env.PI_AGENT_SESSIONS_REAL_SMOKE === "1";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  }, 60_000);

  it("installs into a clean Pi home and activates exactly one package tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-install-smoke-"));
    roots.push(root);
    const home = join(root, "home");
    const target = join(root, "project");
    const auditPath = join(root, "active-tools.json");
    const auditExtension = join(root, "audit.mjs");
    await mkdir(home, { recursive: true });
    await mkdir(target, { recursive: true });
    writeFileSync(
      auditExtension,
      `import { writeFileSync } from "node:fs";\nexport default function (pi) {\n  pi.on("session_start", () => writeFileSync(process.env.AGENT_TOOL_AUDIT, JSON.stringify(pi.getActiveTools())));\n}\n`,
    );
    const env = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_OFFLINE: "1",
      AGENT_TOOL_AUDIT: auditPath,
    };

    const installed = spawnSync("pi", ["install", packageRoot], { cwd: target, env, encoding: "utf8", timeout: 30_000 });
    expect(installed.status, installed.stderr).toBe(0);
    const listed = spawnSync("pi", ["list"], { cwd: target, env, encoding: "utf8", timeout: 30_000 });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(packageRoot);

    const rpc = spawnSync(
      "pi",
      ["--mode", "rpc", "--no-builtin-tools", "--approve", "--extension", auditExtension],
      {
        cwd: target,
        env,
        input: '{"id":"state","type":"get_state"}\n',
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(rpc.status, rpc.stderr).toBe(0);
    expect(rpc.stdout).toContain('"command":"get_state","success":true');
    expect(JSON.parse(readFileSync(auditPath, "utf8"))).toEqual(["agent_session"]);
  }, 60_000);
});
