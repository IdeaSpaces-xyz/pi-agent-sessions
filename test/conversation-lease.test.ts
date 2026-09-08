import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireConversationLease } from "../src/conversations/lease.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-conversation-lease-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation writer lease", () => {
  it("allows one owner, blocks a live owner, and releases idempotently", () => {
    const root = tempRoot();
    const session = join(root, "session.jsonl");
    writeFileSync(session, "{}\n");
    const first = acquireConversationLease(session, root);
    expect(() => acquireConversationLease(session, root)).toThrow("already leased");
    first.release();
    first.release();
    const second = acquireConversationLease(session, root);
    second.release();
  });

  it("reclaims only a lease whose owner is provably dead", () => {
    const root = tempRoot();
    const session = join(root, "session.jsonl");
    writeFileSync(session, "{}\n");
    const initial = acquireConversationLease(session, root);
    const leasePath = initial.path;
    initial.release();
    mkdirSync(leasePath, { recursive: true });
    writeFileSync(join(leasePath, "owner.json"), `${JSON.stringify({
      version: 1,
      nonce: "dead",
      pid: 2_147_483_647,
      sessionFile: session,
      acquiredAt: new Date().toISOString(),
    })}\n`);
    const reclaimed = acquireConversationLease(session, root);
    reclaimed.release();
  });

  it("fails closed on malformed ownership evidence", () => {
    const root = tempRoot();
    const session = join(root, "session.jsonl");
    writeFileSync(session, "{}\n");
    const initial = acquireConversationLease(session, root);
    const leasePath = initial.path;
    initial.release();
    mkdirSync(leasePath, { recursive: true });
    writeFileSync(join(leasePath, "owner.json"), "not-json\n");
    expect(() => acquireConversationLease(session, root)).toThrow("cannot be proved dead");
  });
});
