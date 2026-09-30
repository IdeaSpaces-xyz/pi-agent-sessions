import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ParentPiResources } from "../sessions/types.js";

/** Select only resources already loaded by this Pi parent. Installation alone,
 * the child repository, and model tool arguments never contribute paths. */
export function parentPiResources(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getCommands">,
  ctx: Pick<ExtensionContext, "isProjectTrusted">,
): ParentPiResources {
  const active = new Set(pi.getActiveTools());
  const trusted = (source: { path: string; scope: string }): boolean =>
    source.scope === "user" || source.scope === "temporary" ||
    (source.scope === "project" && ctx.isProjectTrusted());
  const canonical = (path: string): string | undefined => {
    try {
      const file = realpathSync(path);
      const stat = lstatSync(file);
      return stat.isFile() || stat.isDirectory() ? file : undefined;
    } catch { return undefined; }
  };
  const extensionPaths = new Set<string>();
  for (const tool of pi.getAllTools()) {
    if (!active.has(tool.name) || tool.name === "agent_session" || !trusted(tool.sourceInfo)) continue;
    const file = canonical(tool.sourceInfo.path);
    if (file) extensionPaths.add(file);
  }
  const skillPaths = new Set<string>();
  for (const command of pi.getCommands()) {
    if (command.source !== "skill" || !trusted(command.sourceInfo)) continue;
    const file = canonical(command.sourceInfo.path);
    if (file) skillPaths.add(dirname(file)); // one loaded skill, not the whole package library
  }
  if (!extensionPaths.size) {
    throw new Error("No active trusted Pi extensions can be carried to this child. Load the connector in the parent first; installed-but-inactive packages do not grant child tools.");
  }
  return { extensionPaths: [...extensionPaths].sort(), skillPaths: [...skillPaths].sort() };
}
