import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OwnedAgentSessions } from "../sessions/owned-sessions.js";
import type {
  AgentReply,
  OwnedRunSnapshot,
  OwnedSessionsList,
  ListConversationsResult,
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
import { ParentUiAdapter } from "./parent-ui.js";

const POINTER_ENTRY = "agent-session-pointer";
const REPLY_MESSAGE = "agent-session-reply";
const MAX_HISTORY_POINTERS = 50;
const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;
const SESSION_WIDGET = "agent-sessions";
const MAX_WIDGET_RUNS = 4;

const ActionSchema = StringEnum(["list", "conversations", "start", "resume", "send", "status", "interrupt", "close"] as const);
const BusyModeSchema = StringEnum(["steer", "followUp"] as const);
const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

const AgentSessionParams = Type.Object({
  action: ActionSchema,
  agent: Type.Optional(Type.String({ description: "Discovered agent name; required for conversations and start" })),
  runId: Type.Optional(Type.String({ description: "Owned run id; required for send, interrupt, and close" })),
  message: Type.Optional(Type.String({ description: "Message for start or send" })),
  query: Type.Optional(Type.String({ description: "Optional bounded name/first-message query for conversations" })),
  topic: Type.Optional(Type.String({ description: "Optional durable Pi session name for start" })),
  conversationId: Type.Optional(Type.String({ description: "Exact catalog conversation id; required for resume" })),
  busyMode: Type.Optional(BusyModeSchema),
  model: Type.Optional(Type.String({ description: "Optional child model override for start" })),
  thinking: Type.Optional(ThinkingSchema),
  includeEvents: Type.Optional(Type.Boolean({
    description: "Diagnostic only: include transcript, errors, and aggregated bounded event counts in status",
  })),
});

export interface AgentSessionToolInput {
  action: "list" | "conversations" | "start" | "resume" | "send" | "status" | "interrupt" | "close";
  agent?: string;
  runId?: string;
  message?: string;
  query?: string;
  topic?: string;
  conversationId?: string;
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
  let parentUi: ParentUiAdapter | undefined;
  let context: ExtensionContext | undefined;
  let historicalPointers: SessionPointer[] = [];

  const updateWidget = () => {
    if (!sessions) return;
    const status = sessions.status();
    for (const run of status.runs) {
      if (run.session.status === "closed" || run.session.status === "crashed") parentUi?.clearRun(run.session.runId);
    }
    if (context?.mode !== "tui") return;
    try {
      context.ui.setWidget(SESSION_WIDGET, buildSessionWidget(status), {
        placement: "belowEditor",
      });
    } catch {
      // The session UI may already be tearing down.
    }
  };

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
      parentUi = new ParentUiAdapter(
        () => context,
        (runId, id, response) => {
          if (!sessions) return Promise.reject(new Error("The parent session is shutting down"));
          return sessions.respondToDialog(runId, id, response);
        },
      );
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
        uiEvent(event) {
          parentUi?.handle(event);
        },
        stateChanged: updateWidget,
      });
      updateWidget();
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
    parentUi?.shutdown();
    await sessions?.shutdown();
    if (ctx.mode === "tui") ctx.ui.setWidget(SESSION_WIDGET, undefined);
    parentUi = undefined;
    sessions = undefined;
    context = undefined;
  });

  pi.registerTool({
    name: "agent_session",
    label: "Agent Session",
    description:
      "List configured fellow agents and their bounded conversation metadata. Start a new conversation, resume an exact prior conversation in a new owned process, continue a live run, inspect status, interrupt, or close.",
    promptSnippet: "List, start, resume, continue, inspect, interrupt, or close fellow-agent conversations",
    promptGuidelines: [
      "Use agent_session only for configured fellow agents; conversations, start, and resume accept an agent name, never an arbitrary folder or session path.",
      "Start and send return after the background turn begins. Tell the person once, then wait for the automatic fellow-agent reply; do not poll or send another message merely to retrieve it.",
      "When an automatic fellow-agent reply arrives, relay its substantive answer to the person; do not merely acknowledge receipt or repeat transport metadata.",
      "Use status when the person asks, when a reply was held by branch movement, or when diagnosing a problem. Set includeEvents only for diagnostics.",
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
          return result(formatList(list), { list, history: historicalPointers });
        }
        case "conversations": {
          const agent = required(params.agent, "agent_session conversations requires agent");
          onUpdate?.(progress(`Listing ${agent} conversations…`));
          const catalog = await sessions.conversations({ agent, query: params.query });
          return result(formatConversations(catalog), { catalog });
        }
        case "start": {
          const agent = required(params.agent, "agent_session start requires agent");
          const message = required(params.message, "agent_session start requires message");
          onUpdate?.(progress(`Starting ${agent}…`));
          const started = await sessions.start({
            agent,
            message,
            topic: params.topic,
            model: params.model,
            thinking: params.thinking,
          });
          return result(formatOperation("Started", started), { operation: started });
        }
        case "resume": {
          const agent = required(params.agent, "agent_session resume requires agent");
          const conversationId = required(params.conversationId, "agent_session resume requires conversationId");
          const message = required(params.message, "agent_session resume requires message");
          onUpdate?.(progress(`Resuming ${agent} conversation…`));
          const resumed = await sessions.resume({
            agent,
            conversationId,
            message,
            model: params.model,
            thinking: params.thinking,
          });
          return result(formatOperation("Resumed", resumed), { operation: resumed });
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
          return result(formatStatus(status, { detailed: params.includeEvents === true }), {
            status,
            history: historicalPointers,
          });
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
          return result(`Closed ${formatRunLine(closed)}.`, { run: closed });
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

function formatList(list: OwnedSessionsList): string {
  const lines: string[] = [];
  if (list.configurationError) lines.push(list.configurationError);
  else {
    const names = list.roster?.agents.map((agent) => agent.name) ?? [];
    lines.push(`Agents (${names.length}${list.roster?.truncated ? "+; bounded" : ""}): ${names.join(", ") || "none"}`);
  }
  lines.push(`Owned runs (${list.runs.length}):`);
  lines.push(...(list.runs.length ? list.runs.map(formatRunLine) : ["none"]));
  return lines.join("\n");
}

function formatConversations(catalog: ListConversationsResult): string {
  const bounded = catalog.truncated ? "+; bounded" : "";
  const lines = [`${catalog.agent} conversations (${catalog.conversations.length}${bounded}):`];
  if (catalog.conversations.length === 0) lines.push("none");
  for (const conversation of catalog.conversations) {
    const title = (conversation.name ?? conversation.firstMessage) || "(unnamed)";
    lines.push(
      `${conversation.conversationId} — ${title} — ${conversation.modifiedAt} — ${conversation.messageCount} messages`,
    );
  }
  if (catalog.skippedEntries > 0) lines.push(`Skipped invalid or oversized entries: ${catalog.skippedEntries}`);
  return lines.join("\n");
}

function buildSessionWidget(status: OwnedSessionsStatus): string[] | undefined {
  const visible = status.runs.filter((run) => {
    const state = run.session.status;
    return (state !== "closed" && state !== "crashed") || run.unreadReplies > 0;
  });
  if (visible.length === 0) return undefined;
  const lines = [`Fellow agents (${visible.length})`];
  for (const run of visible.slice(0, MAX_WIDGET_RUNS)) {
    const tools = run.session.activeTools.map((tool) => tool.toolName);
    const activity = tools.length > 0 ? ` · ${tools.slice(0, 3).join(", ")}` : "";
    const unread = run.unreadReplies > 0 ? ` · ${run.unreadReplies} unread` : "";
    lines.push(`${run.agent} · ${run.session.status}${activity}${unread}`);
  }
  if (visible.length > MAX_WIDGET_RUNS) lines.push(`…and ${visible.length - MAX_WIDGET_RUNS} more`);
  return lines;
}

function formatStatus(status: OwnedSessionsStatus, options: { detailed: boolean }): string {
  const lines = [`Owned runs (${status.runs.length}):`];
  lines.push(...(status.runs.length ? status.runs.map((run) => formatRunStatus(run, options)) : ["none"]));
  if (status.unread.length > 0) {
    lines.push("", `Unread replies (${status.unread.length}):`);
    for (const reply of status.unread) lines.push(formatReply(reply));
  }
  return lines.join("\n");
}

function formatOperation(verb: string, operation: SessionOperationResult): string {
  const turn = operation.operation;
  const queued = operation.queuedToOperationId;
  const suffix = turn
    ? ` Operation: ${turn.operationId} (${turn.status}).`
    : queued
      ? ` Queued for operation: ${queued}.`
      : "";
  const conversation = operation.run.session.sessionId
    ? ` Conversation: ${operation.run.session.sessionId}.`
    : "";
  return `${verb} ${formatRunLine(operation.run)}.${conversation}${suffix}`;
}

function formatRunLine(run: OwnedRunSnapshot): string {
  const unread = run.unreadReplies > 0 ? ` · ${run.unreadReplies} unread` : "";
  return `${run.agent} — ${run.session.status} — runId: ${run.session.runId}${unread}`;
}

function formatRunStatus(run: OwnedRunSnapshot, options: { detailed: boolean }): string {
  const lines = [formatRunLine(run)];
  if (run.session.activeTools.length > 0) {
    lines.push(`  tools: ${run.session.activeTools.map((tool) => tool.toolName).join(", ")}`);
  }
  const latest = run.session.turns.at(-1);
  if (latest) lines.push(`  latest operationId: ${latest.operationId} (${latest.status})`);
  if (!options.detailed) return lines.join("\n");
  lines.push(`  transcript: ${transcript(run)}`);
  const eventCounts = countEventTypes(run.session.recentEvents);
  if (eventCounts.length > 0) lines.push(`  recent events: ${eventCounts.join(", ")}`);
  if (run.session.protocolError) lines.push(`  protocol error: ${run.session.protocolError}`);
  if (run.session.stderr) lines.push(`  stderr: ${run.session.stderr}`);
  return lines.join("\n");
}

function countEventTypes(events: OwnedRunSnapshot["session"]["recentEvents"]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type} ×${count}`);
}

function formatReply(reply: AgentReply): string {
  const body = reply.reply ?? reply.error ?? "(no reply text)";
  return [
    `[Fellow agent reply — ${reply.agent} · ${reply.outcome} · runId: ${reply.runId}]`,
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
