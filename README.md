# pi-agent-sessions

Persistent, bounded Pi sessions for consulting another agent in its own folder.

The package exposes exactly one Pi tool, `agent_session`, plus a UI-independent controller for other hosts. Each child is an ordinary persistent Pi RPC process with its own working directory, orientation, transcript, and session state. Parent prompts, transcripts, maps, mounts, and session identity are not copied into it.

## Install

Requires Node.js 20 or newer and Pi `0.85.1` or a compatible successor.

```bash
pi install npm:@ideaspaces/pi-agent-sessions@0.1.0
```

Configure one absolute collection root when starting Pi:

```bash
pi --agent-collection /absolute/path/to/agents
```

Only immediate child directories containing a regular `_agent/foundation.md` are discoverable. Discovery is non-recursive, bounded, refreshed on `list` and `start`, and revalidated before spawn. Symlinked agents and foundations are omitted.

Discovery does not approve project resources. By default, a child with project resources starts only when Pi has a positive saved trust decision for that folder. A person can explicitly approve resources for launches from the configured collection:

```bash
pi --agent-collection /absolute/path/to/agents \
  --agent-approve-project-resources
```

Review agents and project resources before enabling approval. Pi extensions execute with the user's system permissions; process isolation is not a filesystem or credential sandbox.

To try a local checkout without installing it:

```bash
pi -e /absolute/path/to/pi-agent-sessions \
  --agent-collection /absolute/path/to/agents
```

## Use

Ask Pi to list or consult a fellow agent. The model uses one tool with six actions:

| Action | Purpose |
|---|---|
| `list` | Refresh the bounded roster and show owned runs. |
| `start` | Start a discovered agent with a required first message. |
| `send` | Continue an idle run, or explicitly `steer`/`followUp` a busy run. |
| `status` | Inspect bounded state and retrieve replies held by branch movement. |
| `interrupt` | Stop the current turn while keeping the child session alive. |
| `close` | Idempotently close the owned process tree. |

A terminal widget shows live child state, active tools, waiting dialogs, and unread replies. Completed replies arrive as labelled Pi custom messages. If the parent moved through `/tree`, the package does not inject into the new branch; `status` returns the held reply instead.

Child `select`, `confirm`, `input`, and `editor` requests are labelled and serialized through one parent FIFO. Responses remain correlated to the requesting child. Missing UI, request timeout, interruption, close, or parent teardown cancels the exact request; absence is never converted into approval. Child notifications, statuses, and string widgets are projected with run-scoped keys. Requests to replace the parent title or editor text are reported as unsupported.

Starting a new session, resuming, forking, reloading, or quitting invalidates delivery and closes all children. Transcript pointers remain in parent session metadata, but a later extension instance does not reattach to old processes. No action accepts an arbitrary working directory or process id, and children cannot launch nested sessions in this release.

## Host configuration

Hosts can supply `PI_AGENT_SESSIONS_CONFIG` as strict JSON. Host configuration takes precedence over terminal flags:

```json
{
  "collectionRoot": "/absolute/path/to/agents",
  "approveProjectResources": false,
  "controller": {
    "executable": { "command": "/absolute/path/to/pi" },
    "limits": {
      "maxChildren": 4,
      "dialogTimeoutMs": 600000
    }
  }
}
```

The host configuration is removed from child environments. Children receive `PI_AGENT_SESSION_DEPTH=1`, and the package does not register `agent_session` inside them.

## Controller

```ts
import { PersistentRpcController } from "@ideaspaces/pi-agent-sessions";

const child = await PersistentRpcController.start({
  target: "/absolute/path/to/an/agent",
  trust: { mode: "saved" },
  // Optional when a host cannot inherit the current Pi CLI:
  executable: { command: "/absolute/path/to/pi" },
});

const stopUi = child.onUiEvent((event) => {
  if (event.type === "request" && event.request.method === "confirm") {
    // A real host asks its person before answering.
    void child.respondToDialog(event.request.id, { confirmed: false }).catch(console.error);
  }
});

const turn = await child.promptAndWait("Review this API boundary.");
console.log(turn.status, turn.reply);

stopUi();
await child.close();
```

Trust is always a separate caller decision:

- `{ mode: "saved" }` requires positive saved Pi trust when the target has project resources and never adds `--approve`.
- `{ mode: "explicit" }` represents a human or host approval for this launch and adds `--approve`.

Process state is observable as `starting`, `idle`, `running`, `waiting_for_input`, `closing`, `closed`, or `crashed`. Turn outcomes are independently recorded as `rejected`, `completed`, `failed`, or `interrupted`.

`interrupt()` clears queued messages before aborting. `close()` cancels outstanding dialogs, settles active work within a bound, closes stdin, and escalates to process-tree termination when needed. All retained observations, replies, stderr, requests, and waits are bounded.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
```

The no-model real smoke verifies Pi startup and clean package installation:

```bash
PI_AGENT_SESSIONS_REAL_SMOKE=1 npm run test:real
```

The opt-in turn smoke uses the locally authenticated model and exercises child orientation, all four RPC dialogs, same-process follow-up, interruption, and close:

```bash
PI_AGENT_SESSIONS_REAL_TURN_SMOKE=1 npm run test:real
```

The full parent smoke additionally verifies labelled dialog forwarding, automatic reply delivery, repeated conversation through one owned run, and explicit close:

```bash
PI_AGENT_SESSIONS_REAL_PARENT_SMOKE=1 npm run test:real
```

Set `PI_AGENT_SESSIONS_REAL_MODEL=provider/model` to select another authenticated model. The regular fake-process suite covers deterministic branch holding, timeout, denial, missing UI, and teardown races.
