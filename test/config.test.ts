import { chmodSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv, buildPiArgv } from "../src/controller/controller.js";
import { DEFAULT_LIMITS, resolveControllerConfig, validateLimits } from "../src/controller/config.js";
import { resolveExecutable, resolvePiLaunch } from "../src/controller/executable.js";
import type { ControllerLimits, ControllerRuntime } from "../src/controller/types.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-sessions-"));
  roots.push(root);
  return root;
}

function runtime(overrides: Partial<ControllerRuntime> = {}): ControllerRuntime {
  return {
    execPath: process.execPath,
    execArgv: [],
    argv: [process.execPath],
    env: process.env,
    platform: process.platform,
    versions: process.versions,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("configuration", () => {
  it("requires a real target and an explicit trust decision", () => {
    const target = tempRoot();
    expect(() => resolveControllerConfig({ target, trust: undefined as never, executable: fakeExecutable() })).toThrow("trust");
    expect(() => resolveControllerConfig({ target: join(target, "missing"), trust: { mode: "saved" }, executable: fakeExecutable() })).toThrow("does not exist");
    writeFileSync(join(target, "file"), "x");
    expect(() => resolveControllerConfig({ target: join(target, "file"), trust: { mode: "saved" }, executable: fakeExecutable() })).toThrow("must be a directory");
  });

  it("canonicalizes resource paths and builds saved versus explicit trust argv", () => {
    const target = tempRoot();
    const extension = join(target, "extension.ts");
    const skills = join(target, "skills");
    writeFileSync(extension, "export default () => {};");
    mkdirSync(skills);
    const saved = resolveControllerConfig({
      target,
      trust: { mode: "saved" },
      extensionPaths: [extension, extension],
      skillPaths: [skills],
      model: "provider/model",
      thinking: "high",
      executable: fakeExecutable(),
    });
    expect(saved.target).toBe(realpathSync(target));
    expect(buildPiArgv(saved)).toEqual([
      "--mode", "rpc", "--model", "provider/model", "--thinking", "high",
      "--no-extensions", "--extension", realpathSync(extension), "--skill", realpathSync(skills),
    ]);
    const explicit = resolveControllerConfig({ target, trust: { mode: "explicit" }, executable: fakeExecutable() });
    expect(buildPiArgv(explicit)).toEqual(["--mode", "rpc", "--approve"]);
  });

  it("requires positive saved trust when the target has project resources", () => {
    const target = tempRoot();
    const agentDir = join(tempRoot(), "agent-home");
    mkdirSync(join(target, ".pi"));
    mkdirSync(agentDir);
    writeFileSync(join(target, ".pi", "settings.json"), "{}\n");

    expect(() =>
      resolveControllerConfig({
        target,
        agentDir,
        trust: { mode: "saved" },
        executable: fakeExecutable(),
      }),
    ).toThrow("not positively trusted");

    writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [realpathSync(target)]: true }, null, 2)}\n`);
    expect(
      resolveControllerConfig({
        target,
        agentDir,
        trust: { mode: "saved" },
        executable: fakeExecutable(),
      }).target,
    ).toBe(realpathSync(target));
    expect(
      resolveControllerConfig({
        target,
        agentDir,
        trust: { mode: "explicit" },
        executable: fakeExecutable(),
      }).trust,
    ).toEqual({ mode: "explicit" });
  });

  it("validates every configured bound", () => {
    for (const [key, defaultValue] of Object.entries(DEFAULT_LIMITS) as Array<[keyof ControllerLimits, number]>) {
      expect(validateLimits({ [key]: defaultValue })[key]).toBe(defaultValue);
      expect(() => validateLimits({ [key]: -1 })).toThrow(key);
      expect(() => validateLimits({ [key]: Number.MAX_SAFE_INTEGER })).toThrow(key);
      expect(() => validateLimits({ [key]: 1.5 })).toThrow(key);
    }
  });

  it("sanitizes parent session state while forwarding explicit runtime paths", () => {
    const target = tempRoot();
    const packageDir = join(target, "package");
    const agentDir = join(target, "agent");
    mkdirSync(packageDir);
    mkdirSync(agentDir);
    const config = resolveControllerConfig({
      target,
      trust: { mode: "saved" },
      packageDir,
      agentDir,
      env: { FAKE_CUSTOM: "yes", REMOVE_ME: undefined },
      executable: fakeExecutable(),
    });
    const env = buildChildEnv({
      PATH: "/bin",
      PI_SESSION_ID: "parent",
      PI_SESSION_FILE: "/parent.jsonl",
      PI_MODEL: "parent-model",
      PI_AGENT_SESSIONS_CONFIG: "parent-config",
      PI_AGENT_SESSION_DEPTH: "9",
      IS_MOUNTS: "secret",
      IS_CHANGE_ID: "change",
      KEEP_ME: "yes",
      REMOVE_ME: "old",
    }, config);
    expect(env).toMatchObject({
      PATH: "/bin",
      KEEP_ME: "yes",
      FAKE_CUSTOM: "yes",
      PI_AGENT_SESSION_DEPTH: "1",
      PI_PACKAGE_DIR: realpathSync(packageDir),
      PI_CODING_AGENT_DIR: realpathSync(agentDir),
    });
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PI_MODEL).toBeUndefined();
    expect(env.PI_AGENT_SESSIONS_CONFIG).toBeUndefined();
    expect(env.PI_AGENT_SESSION_DEPTH).toBe("1");
    expect(env.IS_MOUNTS).toBeUndefined();
    expect(env.IS_CHANGE_ID).toBeUndefined();
    expect(env.REMOVE_ME).toBeUndefined();
  });
});

describe("executable resolution", () => {
  it("resolves an explicit bare command before spawn", () => {
    const root = tempRoot();
    const executable = join(root, process.platform === "win32" ? "fake.CMD" : "fake");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    expect(resolveExecutable("fake", { PATH: root, PATHEXT: ".CMD" }, process.platform)).toBe(realpathSync(executable));
    expect(resolvePiLaunch({ command: "fake", argvPrefix: ["cli.js"] }, runtime({ env: { PATH: root, PATHEXT: ".CMD" } }))).toEqual({
      command: realpathSync(executable), argvPrefix: ["cli.js"], source: "explicit",
    });
  });

  it("uses the current real Pi CLI script under the current runtime", () => {
    const root = tempRoot();
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const cli = join(packageRoot, "dist", "cli.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    writeFileSync(cli, "");
    const launch = resolvePiLaunch(undefined, runtime({ argv: [process.execPath, cli], execArgv: ["--enable-source-maps"] }));
    expect(launch).toEqual({
      command: realpathSync(process.execPath),
      argvPrefix: ["--enable-source-maps", realpathSync(cli)],
      source: "current-cli",
    });
  });

  it("resolves a symlinked current Pi CLI entrypoint", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const cli = join(packageRoot, "dist", "cli.js");
    const link = join(root, "pi");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    writeFileSync(cli, "");
    symlinkSync(cli, link);

    expect(resolvePiLaunch(undefined, runtime({ argv: [process.execPath, link] }))).toEqual({
      command: realpathSync(process.execPath),
      argvPrefix: [realpathSync(cli)],
      source: "current-cli",
    });
  });

  it("uses a current packaged Bun executable and otherwise refuses to guess", () => {
    const bunVersions = { ...process.versions, bun: "1.2.0" } as NodeJS.ProcessVersions;
    expect(resolvePiLaunch(undefined, runtime({ argv: [process.execPath], versions: bunVersions }))).toEqual({
      command: realpathSync(process.execPath), argvPrefix: [], source: "packaged",
    });
    expect(() => resolvePiLaunch(undefined, runtime())).toThrow("provide executable.command");
    expect(() => resolveExecutable("missing-agent-binary", { PATH: tempRoot() }, process.platform)).toThrow("not found");
  });
});

function fakeExecutable() {
  return { command: process.execPath };
}
