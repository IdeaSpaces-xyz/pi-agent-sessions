import type { AgentSessionSnapshot } from "../controller/types.js";

const MAX_LABEL_CHARS = 64;

/** Which harness an owned run is under. A run without a recorded runtime is said to be unknown, not guessed. */
export function harnessLabel(runtime: AgentSessionSnapshot["runtime"]): string {
  if (runtime === "pi") return "Pi";
  if (runtime === "claude") return "Claude";
  return "harness unknown";
}

/**
 * The model evidence for an owned run. An observed model is what the runtime reported; a request is
 * only what was asked for and is labelled so; with neither, the model is said to be unreported.
 */
export function modelLabel(session: Pick<AgentSessionSnapshot, "model" | "observedModel">): string {
  const observed = displayText(session.observedModel);
  const requested = displayText(session.model);
  if (observed) return requested && requested !== observed ? `${observed} (requested ${requested})` : observed;
  if (requested) return `${requested} (requested, not reported)`;
  return "model not reported";
}

/** `agent · harness · model · status`, the identity of one owned run. */
export function runIdentity(agent: string, session: AgentSessionSnapshot): string {
  return [displayText(agent) ?? "(unnamed)", harnessLabel(session.runtime), modelLabel(session), session.status].join(" · ");
}

/** One bounded printable line: no control or bidirectional-override characters, collapsed whitespace. */
export function displayText(value: string | undefined, max = MAX_LABEL_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
