# pi-agent-sessions

Persistent, UI-independent Pi RPC sessions for consulting another agent in its own folder.

The controller starts ordinary Pi in RPC mode, keeps the process alive across turns, and keeps process lifetime separate from each turn's outcome. A child starts from its target folder's own settings and context; parent transcripts, model metadata, mounts, and session identity are not copied into it.

> This repository is under active development. The `agent_session` Pi extension will be added before the first npm release.

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

- `{ mode: "saved" }` lets Pi apply the target's saved trust decision and never adds `--approve`.
- `{ mode: "explicit" }` represents a human or host approval for this launch and adds `--approve`.

Discovery must never choose explicit approval on a person's behalf.

## Lifecycle

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
