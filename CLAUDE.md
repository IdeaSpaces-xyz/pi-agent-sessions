# CLAUDE.md — pi-agent-sessions

Public Pi package for persistent fellow-agent processes.

## Boundary

- `src/controller/` owns child-process and RPC lifecycle without Pi UI.
- Discovery and trust are separate; finding a folder never approves it.
- Children start as ordinary Pi sessions in the target folder. Do not inherit parent transcripts, session ids, model metadata, awareness, maps, mounts, or capture state.
- Use `spawn` with argv arrays and `shell: false`.
- Treat `agent_settled`, not `agent_end`, as operation settlement.
- Keep process state distinct from turn outcome.
- Bound every retained buffer and every wait.
- Close the owned process tree, not only the immediate child.

Public code, fixtures, errors, and examples must use generic names and paths. Do not expose private workspace layout or roadmap links.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
```

Use feature branches and pull requests. Do not push directly to main.
