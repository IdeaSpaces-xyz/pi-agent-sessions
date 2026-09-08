import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverAgentRoster,
  revalidateAgentTarget,
  resolveCollectionRoot,
} from "../src/discovery/discovery.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-roster-"));
  roots.push(root);
  return root;
}

async function makeAgent(root: string, name: string): Promise<string> {
  const target = join(root, name);
  await mkdir(join(target, "_agent"), { recursive: true });
  await writeFile(join(target, "_agent", "foundation.md"), `# ${name}\n`);
  return target;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent roster discovery", () => {
  it("finds only canonical immediate agent directories in stable name order", async () => {
    const root = tempRoot();
    await makeAgent(root, "Frontend");
    await makeAgent(root, "Backend");
    await makeAgent(root, "Integrator");
    await mkdir(join(root, "ordinary-folder"));
    await makeAgent(join(root, "nested"), "Hidden");
    await mkdir(join(root, "Malformed", "_agent"), { recursive: true });
    await mkdir(join(root, "FoundationIsDirectory", "_agent", "foundation.md"), { recursive: true });

    const roster = await discoverAgentRoster(root);

    expect(roster.agents.map((agent) => agent.name)).toEqual(["Backend", "Frontend", "Integrator"]);
    expect(roster.agents.map((agent) => agent.path)).toEqual([
      join(roster.root, "Backend"),
      join(roster.root, "Frontend"),
      join(roster.root, "Integrator"),
    ]);
    expect(roster.truncated).toBe(false);
  });

  it("omits symlinked agents and foundations, including escapes", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const outside = tempRoot();
    const outsideAgent = await makeAgent(outside, "Outside");
    await symlink(outsideAgent, join(root, "EscapedAgent"));

    const linkedFoundation = join(root, "LinkedFoundation", "_agent");
    await mkdir(linkedFoundation, { recursive: true });
    await symlink(join(outsideAgent, "_agent", "foundation.md"), join(linkedFoundation, "foundation.md"));

    const roster = await discoverAgentRoster(root);
    expect(roster.agents).toEqual([]);
  });

  it("revalidates a discovered target immediately before launch", async () => {
    const root = tempRoot();
    const target = await makeAgent(root, "Backend");
    const [entry] = (await discoverAgentRoster(root)).agents;
    expect(await revalidateAgentTarget(root, entry)).toEqual(entry);

    await rm(target, { recursive: true, force: true });
    await expect(revalidateAgentTarget(root, entry)).rejects.toThrow();
  });

  it("bounds returned agents and scanned collection entries", async () => {
    const root = tempRoot();
    await Promise.all(Array.from({ length: 350 }, (_, index) => makeAgent(root, `Agent-${String(index).padStart(3, "0")}`)));

    const roster = await discoverAgentRoster(root, { maxAgents: 25, maxScannedEntries: 300 });
    expect(roster.agents).toHaveLength(25);
    expect(roster.scannedEntries).toBe(300);
    expect(roster.truncated).toBe(true);
  });

  it("requires an existing absolute collection directory and bounded limits", async () => {
    const root = tempRoot();
    await expect(resolveCollectionRoot("relative/agents")).rejects.toThrow("absolute");
    await expect(resolveCollectionRoot(join(root, "missing"))).rejects.toThrow("does not exist");
    await expect(discoverAgentRoster(root, { maxAgents: 0 })).rejects.toThrow("maxAgents");
    await expect(discoverAgentRoster(root, { maxScannedEntries: 10_001 })).rejects.toThrow("maxScannedEntries");
  });
});
