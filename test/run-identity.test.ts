import { describe, expect, it } from "vitest";
import type { AgentSessionSnapshot } from "../src/controller/types.js";
import { piModelLabel } from "../src/controller/controller.js";
import { displayText, harnessLabel, modelLabel, runIdentity } from "../src/extension/run-identity.js";

function session(extra: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { runId: "run-1", cwd: "/tmp/agent", status: "running", activeTools: [], outstandingRequestIds: [],
    outstandingDialogs: [], recentEvents: [], turns: [], stderr: "", ...extra };
}

describe("owned run identity", () => {
  it("names agent, harness, observed model and status", () => {
    expect(runIdentity("scout", session({ runtime: "claude", observedModel: "claude-opus-x" })))
      .toBe("scout · Claude · claude-opus-x · running");
    expect(runIdentity("scout", session({ runtime: "pi", status: "idle", observedModel: "anthropic/claude-x" })))
      .toBe("scout · Pi · anthropic/claude-x · idle");
  });

  it("never passes a request off as the model that ran", () => {
    expect(modelLabel({ model: "sonnet" })).toBe("sonnet (requested, not reported)");
    expect(modelLabel({ model: "sonnet", observedModel: "claude-sonnet-x" })).toBe("claude-sonnet-x (requested sonnet)");
    expect(modelLabel({ model: "same", observedModel: "same" })).toBe("same");
    expect(modelLabel({})).toBe("model not reported");
  });

  it("says an unrecorded harness is unknown", () => {
    expect(harnessLabel(undefined)).toBe("harness unknown");
  });

  it("strips terminal controls and bidi overrides, and bounds the label", () => {
    expect(displayText("evil\u001b[2J‮model")).toBe("evil [2J model");
    expect(displayText("\u0007​ ")).toBeUndefined();
    expect(displayText("m".repeat(100))).toHaveLength(64);
    expect(runIdentity("a\nb", session({ runtime: "pi" }))).toBe("a b · Pi · model not reported · running");
  });

  it("reads Pi's own model report as provider/id", () => {
    expect(piModelLabel("anthropic", "claude-x")).toBe("anthropic/claude-x");
    expect(piModelLabel(undefined, "bare")).toBe("bare");
    expect(piModelLabel("anthropic", undefined)).toBeUndefined();
    expect(piModelLabel("p", "bad\u001bid")).toBeUndefined();
  });
});
