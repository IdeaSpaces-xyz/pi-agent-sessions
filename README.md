# pi-agent-sessions

Bounded fellow sessions from Pi. `agent_session` launches a selected local Agreement POV under Pi or Claude via the IdeaSpaces CLI; configured collection names retain the existing resident Pi RPC controller. A CLI turn resumes by conversation id in a fresh process, not by attaching to the old process. Parent transcripts and mounts are never copied into the child.

## Install

The controller supports Node.js 20 or newer. Running it as a package follows Pi's own runtime requirement; Pi `0.85.1` requires Node.js 22.19 or newer.

```bash
pi install npm:@ideaspaces/pi-agent-sessions@0.2.3
```

For cross-runtime or explicit-path launches, install `@ideaspaces/cli@0.1.53` separately or point `IS_CLI_PATH` at its built `bundle/ideaspaces.js`. An older CLI is refused for explicit Pi launches because it cannot enforce saved project-resource trust. CLI-backed Pi launches need `IDEASPACES_PI_EXTENSIONS` (or the CLI's `--ext`) as before; Claude launches use the person's Claude Code installation and sign-in. A folder carrying its own `_agent/agreement.md` can be selected by absolute or relative path with **no collection configuration**.

Optionally configure an absolute collection root for the legacy named roster and resident Pi controls:

```bash
pi --agent-collection /absolute/path/to/agents
```

Only immediate child directories containing a regular `_agent/agreement.md` or `_agent/foundation.md` are discoverable. Discovery is non-recursive, bounded, refreshed on `list` and `start`, and revalidated before spawn. Symlinked agents and entrypoints are omitted.

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

Ask Pi to list or consult a fellow agent. The model uses one tool with eight actions:

| Action | Purpose |
|---|---|
| `list` | Refresh the bounded roster and show owned runs. |
| `conversations` | List or query bounded prior Pi conversation metadata for one discovered agent. |
| `start` | Start a named collection agent or explicit Agreement path; select `runtime: pi|claude`, model, Pi thinking or Claude effort, and explicit Claude permission policy. |
| `resume` | Continue an exact conversation id in a fresh controller (Claude requires a UUID). |
| `send` | Continue an idle run; resident Pi runs can also `steer`/`followUp` while busy. |
| `status` | Inspect bounded state and retrieve replies held by branch movement. |
| `interrupt` | Stop the current turn while keeping the child session alive. |
| `close` | Idempotently close the owned process tree. |

Claude CLI turns default to restricted Read/Grep/Glob and no MCP tools. To write, pass `readOnly:false`; `bypassPermissions` additionally requires that explicit choice. Read-only is a tool restriction, not a filesystem sandbox. `effort` accepts Claude Code's supported low/medium/high/xhigh/max levels; Pi's `thinking` is separate. A collection agent name addresses a canonical folder; an explicit path addresses **any** local IdeaSpace repo with its own regular Agreement. Neither a collection nor an agent kind is required for the path. An explicit Pi path and all Claude runs use CLI `agent run`; named collection Pi runs retain the resident RPC controller. The Pi controller supports queued busy turns and a durable topic; CLI turns do not. `conversationId` addresses the selected runtime's persisted transcript, while `runId` addresses only this parent's controller. On CLI resume, the conversation must exist at the same POV; an unknown id fails rather than creating a new transcript. `conversations` returns names, bounded first-message previews, dates, and message counts, never transcript paths or bodies. Its optional query matches names and first-message previews; semantic and full-transcript search are not included.

Resident Pi `resume` accepts the exact catalog conversation id and takes an exclusive package lease before opening `pi --session`. CLI-backed turns revalidate the selected Agreement before every spawn, use saved Pi project-resource trust unless explicitly approved, and bound output, failure, and process teardown. Their `resume` requires an existing conversation at that POV; it does **not** lease a live CLI session or keep it running after parent exit. Live detachment is a separate follow-on.

A terminal widget shows live child state, active tools, waiting dialogs, and unread replies. Completed replies arrive as labelled Pi custom messages. If the parent moved through `/tree`, the package does not inject into the new branch; `status` returns the held reply instead.

Normal tool results keep only the agent, clearly labelled `runId`, process state, latest operation, and unread count. Transcript paths, stderr, protocol errors, and aggregated recent-event counts appear only when `status` is called with diagnostic `includeEvents: true`. Streaming `message_update` events update live state and usage but are not retained in diagnostic history. Start and send complete in the background; wait for the automatic reply rather than polling status.

Child `select`, `confirm`, `input`, and `editor` requests are labelled and serialized through one parent FIFO. Responses remain correlated to the requesting child. Missing UI, request timeout, interruption, close, or parent teardown cancels the exact request; absence is never converted into approval. Child notifications, statuses, and string widgets are projected with run-scoped keys. Requests to replace the parent title or editor text are reported as unsupported.

Starting a new session, resuming, forking, reloading, or quitting invalidates delivery and closes all children. Transcript pointers remain in parent session metadata, but a later extension instance does not reattach to old processes. No action accepts an arbitrary process id; explicit local POV paths are validated and child sessions cannot nest in this release. `--agent-approve-project-resources` is an explicit Pi trust override, not a Claude permission bypass; Claude permission mode must be chosen separately (`bypassPermissions` only when explicitly requested).

## Host configuration

Hosts can supply `PI_AGENT_SESSIONS_CONFIG` as strict JSON. Host configuration takes precedence over terminal flags:

```json
{
  "collectionRoot": "/absolute/path/to/agents",
  "approveProjectResources": false,
  "conversations": {
    "maxConversations": 50,
    "maxScannedEntries": 500,
    "maxFileBytes": 4194304
  },
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
