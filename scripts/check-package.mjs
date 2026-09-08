import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pi-agent-sessions-package-"));

try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary], root);
  const tarball = readdirSync(temporary).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce a tarball");

  const extracted = join(temporary, "extracted");
  mkdirSync(extracted);
  run("tar", ["-xzf", join(temporary, tarball), "-C", extracted], root);
  const packageDirectory = join(extracted, "package");
  const installedManifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  if (installedManifest.name !== "@ideaspaces/pi-agent-sessions") {
    throw new Error(`Unexpected packed package name: ${installedManifest.name}`);
  }

  const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const piCli = join(dirname(fileURLToPath(piEntry)), "cli.js");
  const home = join(temporary, "home");
  const project = join(temporary, "project");
  const audit = join(temporary, "audit.mjs");
  const auditOutput = join(temporary, "active-tools.json");
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(
    audit,
    `import { writeFileSync } from "node:fs";\nexport default function (pi) {\n  pi.on("session_start", () => writeFileSync(process.env.AGENT_TOOL_AUDIT, JSON.stringify(pi.getActiveTools())));\n}\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_OFFLINE: "1",
    AGENT_TOOL_AUDIT: auditOutput,
  };

  run(process.execPath, [piCli, "install", packageDirectory], project, env);
  const rpc = run(
    process.execPath,
    [piCli, "--mode", "rpc", "--no-builtin-tools", "--approve", "--extension", audit],
    project,
    env,
    '{"id":"state","type":"get_state"}\n',
  );
  if (!rpc.stdout.includes('"command":"get_state","success":true')) {
    throw new Error(`Packed extension did not complete Pi RPC startup:\n${rpc.stdout}`);
  }
  const activeTools = JSON.parse(readFileSync(auditOutput, "utf8"));
  if (JSON.stringify(activeTools) !== JSON.stringify(["agent_session"])) {
    throw new Error(`Expected exactly one active package tool, received ${JSON.stringify(activeTools)}`);
  }
  console.log(`verified packed clean Pi install: ${installedManifest.name}@${installedManifest.version}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function run(command, args, cwd, env = process.env, input) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}
