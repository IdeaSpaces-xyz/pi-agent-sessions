import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPiResources } from "../src/extension/parent-resources.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parent-resources-")); roots.push(root);
  const user = join(root, "user.ts"); const project = join(root, "project.ts");
  const dormant = join(root, "dormant.ts"); const own = join(root, "sessions.ts");
  for (const path of [user, project, dormant, own]) writeFileSync(path, "export default () => {};\n");
  const skills = join(root, "skills", "review"); mkdirSync(skills, { recursive: true });
  const skill = join(skills, "SKILL.md"); writeFileSync(skill, "# Review\n");
  const source = (path: string, scope: string) => ({ path, scope, source: path, origin: "top-level" });
  const pi = {
    getActiveTools: () => ["is_status", "is_status_alias", "agent_session", "project_tool"],
    getAllTools: () => [
      { name: "is_status", sourceInfo: source(user, "user") },
      { name: "is_status_alias", sourceInfo: source(user, "user") },
      { name: "agent_session", sourceInfo: source(own, "user") },
      { name: "dormant_tool", sourceInfo: source(dormant, "user") },
      { name: "project_tool", sourceInfo: source(project, "project") },
    ],
    getCommands: () => [
      { source: "skill", name: "skill:review", sourceInfo: source(skill, "user") },
      { source: "extension", name: "reload", sourceInfo: source(user, "user") },
    ],
  };
  return { pi, user, project, skills };
}

describe("same-or-narrower Pi parent resources", () => {
  it("uses only active tool source paths and loaded skills, excluding its own controller and dormant code", () => {
    const { pi, user, project, skills } = fixture();
    expect(parentPiResources(pi as never, { isProjectTrusted: () => false })).toEqual({ extensionPaths: [realpathSync(user)], skillPaths: [realpathSync(skills)] });
    expect(parentPiResources(pi as never, { isProjectTrusted: () => true })).toEqual({ extensionPaths: [realpathSync(project), realpathSync(user)].sort(), skillPaths: [realpathSync(skills)] });
  });

  it("fails closed when only installed, inactive or own-controller tools remain", () => {
    const { pi } = fixture();
    const inactive = { ...pi, getActiveTools: () => ["agent_session", "dormant_unknown"] };
    expect(() => parentPiResources(inactive as never, { isProjectTrusted: () => true })).toThrow(/No active trusted Pi extensions/);
  });
});
