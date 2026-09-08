import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface LeaseRecord {
  version: 1;
  nonce: string;
  pid: number;
  sessionFile: string;
  acquiredAt: string;
}

export interface ConversationLease {
  path: string;
  nonce: string;
  setOwnerPid(pid: number): void;
  release(): void;
}

export function acquireConversationLease(
  sessionFile: string,
  agentDir?: string,
  env?: Readonly<Record<string, string | undefined>>,
): ConversationLease {
  const canonicalFile = resolve(sessionFile);
  const environmentAgentDir = env && Object.prototype.hasOwnProperty.call(env, "PI_CODING_AGENT_DIR")
    ? env.PI_CODING_AGENT_DIR
    : process.env.PI_CODING_AGENT_DIR;
  const root = join(resolve(agentDir ?? environmentAgentDir ?? join(homedir(), ".pi", "agent")), "pi-agent-sessions", "leases");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(canonicalFile).digest("hex");
  const leaseDir = join(root, `${key}.lock`);
  const nonce = randomUUID();
  const record: LeaseRecord = {
    version: 1,
    nonce,
    pid: process.pid,
    sessionFile: canonicalFile,
    acquiredAt: new Date().toISOString(),
  };

  acquireDirectory(leaseDir, record);
  let released = false;
  return {
    path: leaseDir,
    nonce,
    setOwnerPid(pid: number) {
      if (released) throw new Error("Conversation lease is already released");
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Conversation lease owner pid is invalid");
      const current = readLease(leaseDir);
      if (current?.nonce !== nonce) throw new Error("Conversation lease ownership changed before process handoff");
      const next = { ...current, pid };
      const ownerPath = join(leaseDir, "owner.json");
      const temporary = join(leaseDir, `.owner-${nonce}.tmp`);
      try {
        writeFileSync(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        renameSync(temporary, ownerPath);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    release() {
      if (released) return;
      released = true;
      const current = readLease(leaseDir);
      if (current?.nonce !== nonce) return;
      rmSync(leaseDir, { recursive: true, force: true });
    },
  };
}

function acquireDirectory(leaseDir: string, record: LeaseRecord): void {
  try {
    mkdirSync(leaseDir, { mode: 0o700 });
    writeRecord(leaseDir, record);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      rmSync(leaseDir, { recursive: true, force: true });
      throw error;
    }
  }

  const existing = readLease(leaseDir);
  if (!existing || processState(existing.pid) !== "dead") {
    throw new Error("Conversation is already leased or its previous owner cannot be proved dead");
  }

  const stale = `${leaseDir}.stale-${randomUUID()}`;
  try {
    renameSync(leaseDir, stale);
  } catch {
    throw new Error("Conversation lease changed while reclaiming it; retry explicitly");
  }
  try {
    mkdirSync(leaseDir, { mode: 0o700 });
    writeRecord(leaseDir, record);
  } catch (error) {
    rmSync(leaseDir, { recursive: true, force: true });
    try {
      renameSync(stale, leaseDir);
    } catch {
      // Preserve the stale evidence at its unique path when restoration races.
    }
    throw error;
  }
  rmSync(stale, { recursive: true, force: true });
}

function writeRecord(leaseDir: string, record: LeaseRecord): void {
  const path = join(leaseDir, "owner.json");
  try {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(leaseDir, { recursive: true, force: true });
    throw error;
  }
}

function readLease(leaseDir: string): LeaseRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(leaseDir, "owner.json"), "utf8")) as Partial<LeaseRecord>;
    if (value.version !== 1 || typeof value.nonce !== "string" || !value.nonce || !Number.isSafeInteger(value.pid) || value.pid! <= 0 || typeof value.sessionFile !== "string") return undefined;
    return value as LeaseRecord;
  } catch {
    return undefined;
  }
}

function processState(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}
