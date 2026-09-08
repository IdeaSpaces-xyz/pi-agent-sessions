import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ChildUiRequest } from "../src/controller/types.js";
import { ParentUiAdapter } from "../src/extension/parent-ui.js";
import type { OwnedUiEvent } from "../src/sessions/types.js";

function dialogEvent(
  agent: string,
  runId: string,
  request: ChildUiRequest,
): OwnedUiEvent {
  return { agent, runId, event: { type: "request", request } };
}

function harness(hasUI = true) {
  const calls: Array<{ method: string; title?: string; key?: string; value?: unknown }> = [];
  const responses: Array<{ runId: string; id: string; response: unknown }> = [];
  const pending: Array<ReturnType<typeof deferred<any>>> = [];
  const ui = {
    select(title: string) {
      calls.push({ method: "select", title });
      const next = deferred<string | undefined>();
      pending.push(next);
      return next.promise;
    },
    confirm(title: string) {
      calls.push({ method: "confirm", title });
      const next = deferred<boolean>();
      pending.push(next);
      return next.promise;
    },
    input(title: string) {
      calls.push({ method: "input", title });
      const next = deferred<string | undefined>();
      pending.push(next);
      return next.promise;
    },
    editor(title: string) {
      calls.push({ method: "editor", title });
      const next = deferred<string | undefined>();
      pending.push(next);
      return next.promise;
    },
    notify(value: string, type?: string) {
      calls.push({ method: `notify:${type ?? "info"}`, value });
    },
    setStatus(key: string, value: string | undefined) {
      calls.push({ method: "setStatus", key, value });
    },
    setWidget(key: string, value: string[] | undefined) {
      calls.push({ method: "setWidget", key, value });
    },
  };
  const context = { hasUI, mode: "tui", ui } as unknown as ExtensionContext;
  const adapter = new ParentUiAdapter(
    () => context,
    async (runId, id, response) => {
      responses.push({ runId, id, response });
    },
  );
  return { adapter, calls, responses, pending, context };
}

describe("ParentUiAdapter", () => {
  it("serializes concurrent child dialogs through one labelled FIFO", async () => {
    const { adapter, calls, responses, pending } = harness();
    adapter.handle(dialogEvent("Backend", "run-a", {
      id: "select-a",
      method: "select",
      title: "Choose",
      options: ["Alpha", "Beta"],
      timeoutMs: 1_000,
    }));
    adapter.handle(dialogEvent("Frontend", "run-b", {
      id: "confirm-b",
      method: "confirm",
      title: "Deploy?",
      message: "Proceed",
      timeoutMs: 1_000,
    }));

    await tick();
    expect(calls.map((call) => call.method)).toEqual(["select"]);
    expect(calls[0].title).toContain("Fellow agent: Backend");
    pending[0].resolve("Beta");
    await waitUntil(() => calls.length === 2);
    expect(calls[1]).toMatchObject({ method: "confirm", title: expect.stringContaining("Frontend") });
    pending[1].resolve(false);
    await waitUntil(() => responses.length === 2);

    expect(responses).toEqual([
      { runId: "run-a", id: "select-a", response: { value: "Beta" } },
      { runId: "run-b", id: "confirm-b", response: { confirmed: false } },
    ]);
  });

  it("cancels exact requests when UI is missing and ignores late parent responses", async () => {
    const missing = harness(false);
    missing.adapter.handle(dialogEvent("Backend", "run-a", {
      id: "input-a",
      method: "input",
      title: "Value",
      timeoutMs: 1_000,
    }));
    await waitUntil(() => missing.responses.length === 1);
    expect(missing.responses[0]).toEqual({ runId: "run-a", id: "input-a", response: { cancelled: true } });

    const late = harness();
    late.adapter.handle(dialogEvent("Frontend", "run-b", {
      id: "editor-b",
      method: "editor",
      title: "Draft",
      timeoutMs: 1_000,
    }));
    await waitUntil(() => late.pending.length === 1);
    late.adapter.handle({
      agent: "Frontend",
      runId: "run-b",
      event: { type: "dialog_closed", id: "editor-b", method: "editor", reason: "timeout" },
    });
    await tick();
    late.pending[0].resolve("too late");
    await tick();
    expect(late.responses).toEqual([]);
  });

  it("projects notifications, namespaced status/widgets, and reports unsafe operations", () => {
    const { adapter, calls } = harness();
    adapter.handle(dialogEvent("Backend", "run-a", {
      id: "notify-a",
      method: "notify",
      message: "blocked",
      notifyType: "warning",
    }));
    adapter.handle(dialogEvent("Backend", "run-a", {
      id: "status-a",
      method: "setStatus",
      statusKey: "job",
      statusText: "running",
    }));
    adapter.handle(dialogEvent("Backend", "run-a", {
      id: "widget-a",
      method: "setWidget",
      widgetKey: "job",
      widgetLines: ["one"],
      widgetPlacement: "belowEditor",
    }));
    adapter.handle(dialogEvent("Backend", "run-a", {
      id: "title-a",
      method: "setTitle",
      title: "replace parent title",
    }));

    expect(calls).toEqual([
      { method: "notify:warning", value: "[Backend] blocked" },
      { method: "setStatus", key: "agent-session-child:run-a:job", value: "Backend: running" },
      { method: "setWidget", key: "agent-session-child-widget:run-a:job", value: ["[Backend] one"] },
      { method: "notify:warning", value: "Backend requested unsupported parent UI operation setTitle." },
    ]);

    adapter.clearRun("run-a");
    expect(calls.slice(-2)).toEqual([
      { method: "setStatus", key: "agent-session-child:run-a:job", value: undefined },
      { method: "setWidget", key: "agent-session-child-widget:run-a:job", value: undefined },
    ]);
  });

  it("bounds retained status projection keys", () => {
    const { adapter, calls } = harness();
    for (let index = 0; index <= 128; index += 1) {
      adapter.handle(dialogEvent("Backend", "run-a", {
        id: `status-${index}`,
        method: "setStatus",
        statusKey: `job-${index}`,
        statusText: "running",
      }));
    }
    expect(calls.filter((call) => call.method === "setStatus")).toHaveLength(128);
    expect(calls.at(-1)).toEqual({ method: "notify:warning", value: "Ignored excess status projection from Backend." });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
