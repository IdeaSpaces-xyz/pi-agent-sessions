import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAgentConversations,
  resolveAgentSessionDir,
  validateConversationLimits,
} from "../src/conversations/catalog.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-conversation-catalog-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent conversation catalog", () => {
  it("lists target-owned sessions newest-first with bounded metadata and query", async () => {
    const root = tempRoot();
    const target = join(root, "Backend");
    const sessions = join(root, "sessions");
    await mkdir(target);
    await mkdir(sessions);
    await writeSession(join(sessions, "2026-09-08T11-00-00_new.jsonl"), target, "new-id", {
      name: "Space Loop",
      firstMessage: "Review the direct Inbox map seam",
    });
    await writeSession(join(sessions, "2026-09-07T11-00-00_old.jsonl"), target, "old-id", {
      firstMessage: "Check billing",
    });

    const catalog = listAgentConversations("Backend", target, {
      env: { PI_CODING_AGENT_SESSION_DIR: sessions },
    });
    expect(catalog).toMatchObject({ agent: "Backend", scannedEntries: 2, skippedEntries: 0, truncated: false });
    expect(catalog.conversations.map((item) => item.conversationId)).toEqual(["new-id", "old-id"]);
    expect(catalog.conversations[0]).toMatchObject({
      name: "Space Loop",
      firstMessage: "Review the direct Inbox map seam",
      messageCount: 2,
    });

    const byName = listAgentConversations("Backend", target, {
      env: { PI_CODING_AGENT_SESSION_DIR: sessions },
      query: "space loop",
    });
    expect(byName.conversations.map((item) => item.conversationId)).toEqual(["new-id"]);
    const byPrompt = listAgentConversations("Backend", target, {
      env: { PI_CODING_AGENT_SESSION_DIR: sessions },
      query: "billing",
    });
    expect(byPrompt.conversations.map((item) => item.conversationId)).toEqual(["old-id"]);
  });

  it("omits foreign, malformed, oversized, symlinked, and duplicate sessions", async () => {
    const root = tempRoot();
    const target = join(root, "Backend");
    const foreign = join(root, "Frontend");
    const sessions = join(root, "sessions");
    await mkdir(target);
    await mkdir(foreign);
    await mkdir(sessions);
    await writeSession(join(sessions, "6-valid.jsonl"), target, "valid-id", { firstMessage: "valid" });
    await writeSession(join(sessions, "5-duplicate.jsonl"), target, "valid-id", { firstMessage: "duplicate" });
    await writeSession(join(sessions, "4-foreign.jsonl"), foreign, "foreign-id", { firstMessage: "foreign" });
    await writeFile(join(sessions, "3-malformed.jsonl"), "not json\n");
    await writeFile(join(sessions, "2-oversized.jsonl"), "x".repeat(2_000));
    await symlink(join(sessions, "6-valid.jsonl"), join(sessions, "1-link.jsonl"));

    const catalog = listAgentConversations("Backend", target, {
      env: { PI_CODING_AGENT_SESSION_DIR: sessions },
      limits: { maxFileBytes: 1_024 },
    });
    expect(catalog.conversations.map((item) => item.conversationId)).toEqual(["valid-id"]);
    expect(catalog.skippedEntries).toBe(5);
  });

  it("bounds scanned files, returned rows, previews, and queries", async () => {
    const root = tempRoot();
    const target = join(root, "Backend");
    const sessions = join(root, "sessions");
    await mkdir(target);
    await mkdir(sessions);
    for (let index = 0; index < 4; index += 1) {
      await writeSession(join(sessions, `${index}.jsonl`), target, `session-${index}`, {
        firstMessage: `message ${index} ${"x".repeat(100)}`,
      });
    }

    const catalog = listAgentConversations("Backend", target, {
      env: { PI_CODING_AGENT_SESSION_DIR: sessions },
      limits: { maxConversations: 1, maxScannedEntries: 2, maxPreviewChars: 32 },
    });
    expect(catalog).toMatchObject({ scannedEntries: 2, truncated: true });
    expect(catalog.conversations).toHaveLength(1);
    expect(catalog.conversations[0].firstMessage).toHaveLength(32);
    expect(() => listAgentConversations("Backend", target, {
      env: { PI_CODING_AGENT_SESSION_DIR: sessions },
      query: "too long",
      limits: { maxQueryChars: 3 },
    })).toThrow("query cannot exceed");
    expect(() => validateConversationLimits({ maxConversations: 3, maxScannedEntries: 2 })).toThrow("cannot exceed");
  });

  it("resolves relative session directories against the agent target", async () => {
    const root = tempRoot();
    const target = join(root, "Backend");
    await mkdir(target);
    expect(resolveAgentSessionDir(target, {
      env: { PI_CODING_AGENT_SESSION_DIR: ".pi/sessions" },
    })).toBe(join(realpathSync(target), ".pi", "sessions"));
  });
});

async function writeSession(
  path: string,
  cwd: string,
  id: string,
  input: { name?: string; firstMessage: string },
): Promise<void> {
  const entries: unknown[] = [
    { type: "session", version: 3, id, timestamp: "2026-09-08T10:00:00.000Z", cwd },
    {
      type: "message",
      id: "user001",
      parentId: null,
      timestamp: "2026-09-08T10:00:01.000Z",
      message: { role: "user", content: input.firstMessage, timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant001",
      parentId: "user001",
      timestamp: "2026-09-08T10:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 2 },
    },
  ];
  if (input.name) entries.push({
    type: "session_info",
    id: "name001",
    parentId: "assistant001",
    timestamp: "2026-09-08T10:00:03.000Z",
    name: input.name,
  });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
