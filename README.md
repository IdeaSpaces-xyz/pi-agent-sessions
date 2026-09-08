# pi-agent-sessions

Persistent Pi sessions for consulting another agent in its own folder.

The package exposes one `agent_session` tool and a UI-independent controller. Each child is an ordinary Pi RPC process with its own working directory, orientation, transcript, and session state. Parent prompts, transcripts, maps, mounts, and session identity are not copied into it.

> This repository is under active development. Version `0.1.0` will be published after terminal dialog forwarding is complete.

## Agent collection

Configure one absolute collection root. Only immediate child directories containing a regular `_agent/foundation.md` are discoverable. Discovery is non-recursive, bounded, refreshed on `list` and `start`, and revalidated before spawn. Symlinked agents and foundations are omitted.

For terminal use:

```bash
pi -e /absolute/path/to/pi-agent-sessions \
  --agent-collection /absolute/path/to/agents
```

Discovery does not approve project resources. By default, a child with project resources starts only when Pi has a positive saved trust decision for that folder. A person can explicitly approve resources for these launches with:

```bash
pi -e /absolute/path/to/pi-agent-sessions \
  --agent-collection /absolute/path/to/agents \
  --agent-approve-project-resources
```

Hosts can instead supply `PI_AGENT_SESSIONS_CONFIG` as strict JSON. Host configuration takes precedence over terminal flags:

```json
{
  "collectionRoot": "/absolute/path/to/agents",
  "approveProjectResources": false,
  "controller": {
    "executable": { "command": "/absolute/path/to/pi" },
    "limits": { "maxChildren": 4 }
  }
}
```

The host configuration is removed from child environments. Children receive `PI_AGENT_SESSION_DEPTH=1`, and the package does not register `agent_session` inside them.

## Tool

`agent_session` has six actions:

| Action | Purpose |
|---|---|
| `list` | Refresh the bounded roster and show owned runs. |
| `start` | Start a discovered agent with a required first message. |
| `send` | Continue an idle run, or explicitly `steer`/`followUp` a busy run. |
| `status` | Inspect bounded state and retrieve replies held by branch movement. |
| `interrupt` | Stop the current turn while keeping the child session alive. |
| `close` | Idempotently close the owned process tree. |

A completed child reply is delivered as a labelled Pi custom message. If the parent has moved through `/tree`, the package does not inject into the new branch; `status` returns the held reply instead. Starting a new session, resuming, forking, reloading, or quitting invalidates delivery and closes all children. Transcript pointers remain in parent session metadata, but a later extension instance does not reattach to old processes.

No action accepts an arbitrary working directory or process id.

## Controller

```ts
import { PersistentRpcController } from "@ideaspaces/pi-agent-sessions";

const child = await PersistentRpcController.start({
  target: "/absolute/path/to/an/agent",
  trust: { mode: "saved" },
  // Optional for hosts that cannot inherit the currently running Pi CLI:
  executable: { command: "/absolute/path/to/pi" },
});

const turn = await child.promptAndWait("Review this API boundary.");
console.log(turn.status, turn.reply);

await child.close();
```

Trust is always a separate caller decision:

- `{ mode: "saved" }` requires positive saved Pi trust when the target has project resources and never adds `--approve`.
- `{ mode: "explicit" }` represents a human or host approval for this launch and adds `--approve`.

Process state is observable as `starting`, `idle`, `running`, `waiting_for_input`, `closing`, `closed`, or `crashed`. Turn outcomes are independently recorded as `rejected`, `completed`, `failed`, or `interrupted`.

`interrupt()` clears queued messages before aborting. `close()` cancels outstanding dialogs, settles active work within a bound, closes stdin, and escalates to process-tree termination when needed.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
```

An opt-in smoke starts the installed `pi` binary without sending a model prompt:

```bash
PI_AGENT_SESSIONS_REAL_SMOKE=1 npm run test:real
```
