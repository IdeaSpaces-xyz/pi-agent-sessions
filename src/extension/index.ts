import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OwnedAgentSessions } from "../sessions/owned-sessions.js";
import type {
  AgentReply,
  OwnedRunSnapshot,
  OwnedSessionsList,
  OwnedSessionsStatus,
  SessionOperationResult,
  SessionPointer,
} from "../sessions/types.js";
import {
  APPROVE_FLAG,
  COLLECTION_FLAG,
  DEPTH_ENV,
  parseDepth,
  resolveExtensionConfig,
} from "./config.js";

const POINTER_ENTRY = "agent-session-pointer";
const REPLY_MESSAGE = "agent-session-reply";
const MAX_HISTORY_POINTERS = 50;
const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;

const ActionSchema = StringEnum(["list", "start", "send", "status", "interrupt", "close"] as const);
const BusyModeSchema = StringEnum(["steer", "followUp"] as const);
const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

const AgentSessionParams = Type.Object({
  action: ActionSchema,
  agent: Type.Optional(Type.String({ description: "Discovered agent name; required for start" })),
  runId: Type.Optional(Type.String({ description: "Owned run id; required for send, interrupt, and close" })),
  message: Type.Optional(Type.String({ description: "Message for start or send" })),
  busyMode: Type.Optional(BusyModeSchema),
  model: Type.Optional(Type.String({ description: "Optional child model override for start" })),
  thinking: Type.Optional(ThinkingSchema),
  includeEvents: Type.Optional(Type.Boolean({ description: "Include bounded recent events in status" })),
});

export interface AgentSessionToolInput {
  action: "list" | "start" | "send" | "status" | "interrupt" | "close";
  agent?: string;
  runId?: string;
  message?: string;
  busyMode?: "steer" | "followUp";
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  includeEvents?: boolean;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export default function agentSessionsExtension(pi: ExtensionAPI): void {
  pi.registerFlag(COLLECTION_FLAG, {
    description: "Absolute path whose immediate agent folders form the fellow-agent roster",
    type: "string",
  });
  pi.registerFlag(APPROVE_FLAG, {
    description: "Approve project resources for child launches from the configured collection",
    type: "boolean",
    default: false,
  });

  let configError: string | undefined;
  let sessions: OwnedAgentSessions | undefined;
  let context: ExtensionContext | undefined;
  let historicalPointers: SessionPointer[] = [];

  try {
    if (parseDepth(process.env[DEPTH_ENV]) > 0) return;
  } catch (error) {
    configError = errorMessage(error);
  }

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    historicalPointers = ctx.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === POINTER_ENTRY ? [entry.data] : [],
      )
      .filter(isSessionPointer)
      .slice(-MAX_HISTORY_POINTERS);
    if (configError) return;

    try {
      const resolved = resolveExtensionConfig(pi);
      sessions = new OwnedAgentSessions(resolved.sessions, {
        deliver(reply) {
          pi.sendMessage(
            {
              customType: REPLY_MESSAGE,
              content: boundText(formatReply(reply)),
              display: true,
              details: reply,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        },
        replyHeld(reply) {
          safeNotify(
            context,
            `${reply.agent} finished on an earlier conversation branch. Use agent_session status to retrieve the unread reply.`,
            "warning",
          );
        },
        pointer(pointer) {
          historicalPointers.push(pointer);
          historicalPointers = historicalPointers.slice(-MAX_HISTORY_POINTERS);
          try {
            pi.appendEntry(POINTER_ENTRY, pointer);
          } catch (error) {
            safeNotify(context, `Could not persist the ${pointer.agent} transcript pointer: ${errorMessage(error)}`, "warning");
          }
        },
      });
    } catch (error) {
      configError = errorMessage(error);
      sessions = undefined;
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    sessions?.advanceBranch();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    context = ctx;
    await sessions?.shutdown();
    context = undefined;
  });

  pi.registerTool({
    name: "agent_session",
    label: "Agent Session",
    description:
      "List configured fellow agents and own persistent Pi child sessions. Start only a discovered agent, continue its existing run, inspect bounded status and unread replies, interrupt one turn, or close the process.",
    promptSnippet: "List, start, continue, inspect, interrupt, or close persistent fellow-agent sessions",
    promptGuidelines: [
      "Use agent_session only for configured fellow agents; start accepts an agent name, never an arbitrary folder.",
      "A successful agent_session start or send continues in the background; do not repeatedly poll unless the person asks or automatic delivery was held by branch movement.",
      "Use agent_session interrupt to stop one child turn while preserving its session; use close only to end the child process.",
    ],
    parameters: AgentSessionParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx): Promise<ToolResult> {
      context = ctx;
      if (configError) throw new Error(`agent_session is unavailable: ${configError}`);
      if (!sessions) throw new Error("agent_session is unavailable in nested child sessions");

      switch (params.action) {
        case "list": {
          onUpdate?.(progress("Refreshing the fellow-agent roster…"));
          const list = await sessions.list();
          return result(formatList(list, historicalPointers), { list, history: historicalPointers });
        }
        case "start": {
          const agent = required(params.agent, "agent_session start requires agent");
          const message = required(params.message, "agent_session start requires message");
          onUpdate?.(progress(`Starting ${agent}…`));
          const started = await sessions.start({ agent, message, model: params.model, thinking: params.thinking });
          return result(formatOperation("Started", started), { operation: started });
        }
        case "send": {
          const runId = required(params.runId, "agent_session send requires runId");
          const message = required(params.message, "agent_session send requires message");
          onUpdate?.(progress(`Sending to ${runId}…`));
          const sent = await sessions.send({ runId, message, busyMode: params.busyMode });
          return result(formatOperation("Sent", sent), { operation: sent });
        }
        case "status": {
          const status = sessions.status({
            runId: params.runId,
            includeEvents: params.includeEvents,
            consumeUnread: true,
          });
          return result(formatStatus(status, historicalPointers), { status, history: historicalPointers });
        }
        case "interrupt": {
          const runId = required(params.runId, "agent_session interrupt requires runId");
          onUpdate?.(progress(`Interrupting ${runId}…`));
          const interrupted = await sessions.interrupt(runId);
          return result(formatOperation("Interrupted", interrupted), { operation: interrupted });
        }
        case "close": {
          const runId = required(params.runId, "agent_session close requires runId");
          onUpdate?.(progress(`Closing ${runId}…`));
          const closed = await sessions.close(runId);
          return result(`Closed ${formatRunLine(closed)}. Transcript: ${transcript(closed)}.`, { run: closed });
        }
      }
    },

    renderCall(args, theme, renderContext) {
      const text = (renderContext.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const target = args.agent ?? args.runId;
      text.setText(
        theme.fg("toolTitle", theme.bold("agent_session ")) +
          theme.fg("accent", args.action) +
          (target ? ` ${theme.fg("dim", target)}` : ""),
      );
      return text;
    },

    renderResult(toolResult, options, theme, renderContext) {
      const text = (renderContext.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const raw = toolResult.content.find((part) => part.type === "text")?.text ?? "(no output)";
      const lines = options.expanded ? raw : raw.split("\n").slice(0, 8).join("\n");
      const suffix = !options.expanded && raw.split("\n").length > 8 ? "\n…" : "";
      text.setText(theme.fg(options.isPartial ? "warning" : "toolOutput", `${lines}${suffix}`));
      return text;
    },
  });
}

function formatList(list: OwnedSessionsList, history: SessionPointer[]): string {
  const lines: string[] = [];
  if (list.configurationError) lines.push(list.configurationError);
  else {
    const names = list.roster?.agents.map((agent) => agent.name) ?? [];
    lines.push(`Agents (${names.length}${list.roster?.truncated ? "+; bounded" : ""}): ${names.join(", ") || "none"}`);
  }
  lines.push(`Owned runs (${list.runs.length}):`);
  lines.push(...(list.runs.length ? list.runs.map(formatRunLine) : ["none"]));
  if (history.length > 0) lines.push(`Transcript pointers retained: ${history.length}`);
  return lines.join("\n");
}

function formatStatus(status: OwnedSessionsStatus, history: SessionPointer[]): string {
  const lines = [`Owned runs (${status.runs.length}):`];
  lines.push(...(status.runs.length ? status.runs.map(formatRunStatus) : ["none"]));
  if (status.unread.length > 0) {
    lines.push("", `Unread replies (${status.unread.length}):`);
    for (const reply of status.unread) lines.push(formatReply(reply));
  }
  if (history.length > 0) lines.push("", `Transcript pointers retained: ${history.length}`);
  return lines.join("\n");
}

function formatOperation(verb: string, operation: SessionOperationResult): string {
  const turn = operation.operation;
  const queued = operation.queuedToOperationId;
  const suffix = turn
    ? ` Operation ${turn.operationId}: ${turn.status}.`
    : queued
      ? ` Queued into active operation ${queued}.`
      : "";
  return `${verb} ${formatRunLine(operation.run)}.${suffix} Transcript: ${transcript(operation.run)}.`;
}

function formatRunLine(run: OwnedRunSnapshot): string {
  const unread = run.unreadReplies > 0 ? `, ${run.unreadReplies} unread` : "";
  return `${run.agent} — ${run.session.status} — ${run.session.runId}${unread}`;
}

function formatRunStatus(run: OwnedRunSnapshot): string {
  const lines = [formatRunLine(run), `  transcript: ${transcript(run)}`];
  if (run.session.activeTools.length > 0) {
    lines.push(`  tools: ${run.session.activeTools.map((tool) => tool.toolName).join(", ")}`);
  }
  const latest = run.session.turns.at(-1);
  if (latest) lines.push(`  latest operation: ${latest.operationId} (${latest.status})`);
  if (run.session.recentEvents.length > 0) {
    lines.push(`  recent events: ${run.session.recentEvents.map((event) => event.type).join(", ")}`);
  }
  if (run.session.protocolError) lines.push(`  protocol error: ${run.session.protocolError}`);
  if (run.session.stderr) lines.push(`  stderr: ${run.session.stderr}`);
  return lines.join("\n");
}

function formatReply(reply: AgentReply): string {
  const body = reply.reply ?? reply.error ?? "(no reply text)";
  return [
    `[Fellow agent reply — ${reply.agent}]`,
    `Run: ${reply.runId}`,
    `Operation: ${reply.operationId}`,
    `Outcome: ${reply.outcome}`,
    "",
    body,
  ].join("\n");
}

function transcript(run: OwnedRunSnapshot): string {
  return run.session.sessionFile ?? run.session.sessionId ?? "not available";
}

function result(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: boundText(text) }], details };
}

function progress(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: { progress: true } };
}

function boundText(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return value;
  let output = bytes.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  output += `\n\n[Output truncated at ${MAX_TOOL_OUTPUT_BYTES} bytes; bounded details remain available.]`;
  return output;
}

function required(value: string | undefined, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value;
}

function safeNotify(
  ctx: ExtensionContext | undefined,
  message: string,
  type: "info" | "warning" | "error",
): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(message, type);
  } catch {
    // The parent may have begun teardown after the child settled.
  }
}

function isSessionPointer(value: unknown): value is SessionPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pointer = value as Partial<SessionPointer>;
  return (
    (pointer.event === "started" || pointer.event === "closed") &&
    typeof pointer.agent === "string" &&
    typeof pointer.runId === "string" &&
    typeof pointer.cwd === "string" &&
    typeof pointer.at === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
