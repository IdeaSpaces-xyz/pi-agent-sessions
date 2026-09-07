import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_PI_SCENARIO ?? "normal";
const recordPath = process.env.FAKE_PI_RECORD;
let promptCount = 0;
let input = Buffer.alloc(0);
let descendant;
const steering = [];
const followUp = [];

if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);

if (recordPath) {
  writeFileSync(recordPath, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    depth: process.env.PI_AGENT_SESSION_DEPTH,
    sessionId: process.env.PI_SESSION_ID,
    mounts: process.env.IS_MOUNTS,
    model: process.env.PI_MODEL,
    packageDir: process.env.PI_PACKAGE_DIR,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    custom: process.env.FAKE_CUSTOM,
  }));
}

if (scenario === "stubborn-descendant") {
  process.on("SIGTERM", () => {});
  descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  if (process.env.FAKE_DESCENDANT_RECORD) writeFileSync(process.env.FAKE_DESCENDANT_RECORD, String(descendant.pid));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, success = true, extra = {}) {
  emit({ type: "response", id: command.id, command: command.type, success, ...extra });
}

function assistant(text, stopReason = "stop") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      usage: { input: 10, output: 3, totalTokens: 13, cost: { total: 0.001 } },
    },
  };
}

function completePrompt(command) {
  promptCount += 1;
  response(command);
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "tool_execution_start", toolCallId: `tool-${promptCount}-a`, toolName: "read" });
  emit({ type: "tool_execution_start", toolCallId: `tool-${promptCount}-b`, toolName: "bash" });
  emit({ type: "tool_execution_end", toolCallId: `tool-${promptCount}-b`, toolName: "bash" });
  emit({ type: "tool_execution_end", toolCallId: `tool-${promptCount}-a`, toolName: "read" });
  emit(assistant(`reply ${promptCount}: ${command.message}`));
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled" });
}

function handle(command) {
  if (process.env.FAKE_COMMAND_RECORD) appendFileSync(process.env.FAKE_COMMAND_RECORD, `${JSON.stringify(command)}\n`);
  if (command.type === "get_state") {
    if (scenario === "handshake-timeout") return;
    if (scenario === "malformed-start") {
      process.stdout.write("{not-json}\n");
      return;
    }
    response(command, true, {
      data: {
        sessionId: "fake-session",
        sessionFile: `${process.cwd()}/.pi/sessions/fake.jsonl`,
        isStreaming: false,
        thinkingLevel: "medium",
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    return;
  }

  if (command.type === "prompt") {
    if (scenario === "reject") {
      response(command, false, { error: "fake rejection" });
      return;
    }
    if (scenario === "crash") {
      response(command);
      setImmediate(() => process.exit(17));
      return;
    }
    if (scenario === "parse-failure") {
      response(command);
      process.stdout.write("definitely not json\n");
      return;
    }
    if (scenario === "settled-no-reply") {
      response(command);
      emit({ type: "agent_start" });
      emit({ type: "agent_settled" });
      return;
    }
    if (scenario === "retry") {
      response(command);
      emit({ type: "agent_start" });
      emit({ type: "agent_end", messages: [], willRetry: true });
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "busy" });
      emit(assistant("after retry"));
      emit({ type: "auto_retry_end", success: true, attempt: 1 });
      emit({ type: "agent_settled" });
      return;
    }
    if (scenario === "split-unicode") {
      response(command);
      const bytes = Buffer.from(`${JSON.stringify(assistant("left 😀  right"))}\n`);
      const emoji = bytes.indexOf(Buffer.from("😀"));
      process.stdout.write(bytes.subarray(0, emoji + 1));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(emoji + 1));
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "hold" || scenario === "dialog") {
      response(command);
      emit({ type: "agent_start" });
      emit({ type: "tool_execution_start", toolCallId: "held-a", toolName: "read" });
      emit({ type: "tool_execution_start", toolCallId: "held-b", toolName: "bash" });
      if (scenario === "dialog") {
        emit({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Proceed?", message: "Continue" });
      }
      return;
    }
    completePrompt(command);
    return;
  }

  if (command.type === "steer" || command.type === "follow_up") {
    (command.type === "steer" ? steering : followUp).push(command.message);
    response(command);
    return;
  }

  if (command.type === "clear_queue") {
    response(command, true, { data: { steering: steering.splice(0), followUp: followUp.splice(0) } });
    return;
  }

  if (command.type === "abort") {
    emit({ type: "tool_execution_end", toolCallId: "held-b", toolName: "bash" });
    emit({ type: "tool_execution_end", toolCallId: "held-a", toolName: "read" });
    emit(assistant("interrupted", "aborted"));
    emit({ type: "agent_settled" });
    response(command);
    return;
  }

  if (command.type === "extension_ui_response") {
    if (recordPath) appendFileSync(recordPath, `\n${JSON.stringify(command)}`);
    if (scenario === "dialog") {
      emit(assistant(command.cancelled ? "cancelled" : "dialog answered", command.cancelled ? "aborted" : "stop"));
      emit({ type: "agent_settled" });
    }
    return;
  }

  response(command, false, { error: `unsupported command ${command.type}` });
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const newline = input.indexOf(0x0a);
    if (newline === -1) break;
    const line = input.subarray(0, newline).toString("utf8");
    input = input.subarray(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

process.stdin.on("end", () => {
  if (scenario !== "stubborn-descendant") process.exit(0);
});
