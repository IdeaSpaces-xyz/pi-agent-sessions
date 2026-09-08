import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildDialogRequest, ChildUiRequest } from "../controller/types.js";
import type { OwnedUiEvent } from "../sessions/types.js";

type DialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };
type RespondToDialog = (runId: string, id: string, response: DialogResponse) => Promise<void>;

interface QueuedDialog {
  agent: string;
  runId: string;
  request: ChildDialogRequest;
  cancelled: boolean;
  abort: AbortController;
  closed: ReturnType<typeof deferred<void>>;
}

const STATUS_PREFIX = "agent-session-child:";
const WIDGET_PREFIX = "agent-session-child-widget:";
const MAX_PROJECTED_KEYS = 128;

/** Serializes child dialogs through one parent UI without granting the child direct UI ownership. */
export class ParentUiAdapter {
  private readonly queue: QueuedDialog[] = [];
  private readonly projectedStatuses = new Set<string>();
  private readonly projectedWidgets = new Set<string>();
  private active: QueuedDialog | undefined;
  private accepting = true;
  private draining = false;

  constructor(
    private readonly getContext: () => ExtensionContext | undefined,
    private readonly respond: RespondToDialog,
  ) {}

  handle(owned: OwnedUiEvent): void {
    const { event } = owned;
    if (event.type === "dialog_closed") {
      this.dismiss(owned.runId, event.id);
      return;
    }

    const request = event.request;
    if (isDialog(request)) {
      if (!this.accepting) return;
      this.queue.push({
        agent: owned.agent,
        runId: owned.runId,
        request,
        cancelled: false,
        abort: new AbortController(),
        closed: deferred<void>(),
      });
      void this.drain();
      return;
    }

    this.projectNonBlocking(owned);
  }

  clearRun(runId: string): void {
    const context = this.getContext();
    if (!context?.hasUI) return;
    const statusPrefix = `${STATUS_PREFIX}${runId}:`;
    const widgetPrefix = `${WIDGET_PREFIX}${runId}:`;
    for (const key of [...this.projectedStatuses]) {
      if (!key.startsWith(statusPrefix)) continue;
      context.ui.setStatus(key, undefined);
      this.projectedStatuses.delete(key);
    }
    for (const key of [...this.projectedWidgets]) {
      if (!key.startsWith(widgetPrefix)) continue;
      context.ui.setWidget(key, undefined);
      this.projectedWidgets.delete(key);
    }
  }

  shutdown(): void {
    this.accepting = false;
    for (const dialog of this.queue.splice(0)) this.cancelLocally(dialog);
    if (this.active) this.cancelLocally(this.active);
    const context = this.getContext();
    if (!context?.hasUI) return;
    for (const key of this.projectedStatuses) context.ui.setStatus(key, undefined);
    for (const key of this.projectedWidgets) context.ui.setWidget(key, undefined);
    this.projectedStatuses.clear();
    this.projectedWidgets.clear();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.accepting && this.queue.length > 0) {
        const dialog = this.queue.shift()!;
        if (dialog.cancelled) continue;
        this.active = dialog;
        await this.present(dialog);
        if (this.active === dialog) this.active = undefined;
      }
    } finally {
      this.draining = false;
    }
  }

  private async present(dialog: QueuedDialog): Promise<void> {
    const context = this.getContext();
    if (!context?.hasUI) {
      await this.answer(dialog, { cancelled: true });
      return;
    }

    let response: DialogResponse;
    const parentPrompt = askParent(context, dialog);
    try {
      response = await Promise.race([
        parentPrompt,
        dialog.closed.promise.then(() => ({ cancelled: true }) as const),
      ]);
      // Pi's editor API has no AbortSignal. Keep the FIFO blocked until its stale parent UI closes,
      // even though the exact child request has already been cancelled.
      if (dialog.cancelled && dialog.request.method === "editor") await parentPrompt.catch(() => undefined);
    } catch (error) {
      safeNotify(context, `${dialog.agent} dialog failed: ${errorMessage(error)}`, "warning");
      response = { cancelled: true };
    }
    if (!dialog.cancelled) await this.answer(dialog, response);
  }

  private async answer(dialog: QueuedDialog, response: DialogResponse): Promise<void> {
    if (dialog.cancelled || !this.accepting) return;
    try {
      await this.respond(dialog.runId, dialog.request.id, response);
    } catch (error) {
      if (!dialog.cancelled) {
        safeNotify(this.getContext(), `${dialog.agent} dialog could not be answered: ${errorMessage(error)}`, "warning");
      }
    }
  }

  private dismiss(runId: string, id: string): void {
    if (this.active?.runId === runId && this.active.request.id === id) {
      this.cancelLocally(this.active);
      return;
    }
    const index = this.queue.findIndex((item) => item.runId === runId && item.request.id === id);
    if (index === -1) return;
    const [dialog] = this.queue.splice(index, 1);
    if (dialog) this.cancelLocally(dialog);
  }

  private cancelLocally(dialog: QueuedDialog): void {
    if (dialog.cancelled) return;
    dialog.cancelled = true;
    dialog.abort.abort();
    dialog.closed.resolve();
  }

  private projectNonBlocking(owned: OwnedUiEvent): void {
    const context = this.getContext();
    if (!context?.hasUI || owned.event.type !== "request") return;
    const request = owned.event.request;
    switch (request.method) {
      case "notify":
        safeNotify(context, `[${owned.agent}] ${request.message}`, request.notifyType);
        return;
      case "setStatus": {
        const key = `${STATUS_PREFIX}${owned.runId}:${request.statusKey}`;
        if (
          request.statusText !== undefined &&
          !this.projectedStatuses.has(key) &&
          this.projectedStatuses.size >= MAX_PROJECTED_KEYS
        ) {
          safeNotify(context, `Ignored excess status projection from ${owned.agent}.`, "warning");
          return;
        }
        if (request.statusText === undefined) this.projectedStatuses.delete(key);
        else this.projectedStatuses.add(key);
        context.ui.setStatus(key, request.statusText === undefined ? undefined : `${owned.agent}: ${request.statusText}`);
        return;
      }
      case "setWidget": {
        const key = `${WIDGET_PREFIX}${owned.runId}:${request.widgetKey}`;
        if (
          request.widgetLines !== undefined &&
          !this.projectedWidgets.has(key) &&
          this.projectedWidgets.size >= MAX_PROJECTED_KEYS
        ) {
          safeNotify(context, `Ignored excess widget projection from ${owned.agent}.`, "warning");
          return;
        }
        if (request.widgetLines === undefined) this.projectedWidgets.delete(key);
        else this.projectedWidgets.add(key);
        const lines = request.widgetLines?.map((line, index) => index === 0 ? `[${owned.agent}] ${line}` : line);
        context.ui.setWidget(key, lines, { placement: request.widgetPlacement });
        return;
      }
      case "setTitle":
      case "set_editor_text":
        safeNotify(context, `${owned.agent} requested unsupported parent UI operation ${request.method}.`, "warning");
        return;
      case "unsupported":
        safeNotify(context, `${owned.agent} requested unsupported child UI operation ${request.requestedMethod}.`, "warning");
        return;
    }
  }
}

async function askParent(context: ExtensionContext, dialog: QueuedDialog): Promise<DialogResponse> {
  const request = dialog.request;
  const title = `[Fellow agent: ${dialog.agent}] ${request.title}`;
  const options = { signal: dialog.abort.signal, timeout: request.timeoutMs };
  switch (request.method) {
    case "select": {
      const value = await context.ui.select(title, request.options, options);
      return value === undefined ? { cancelled: true } : { value };
    }
    case "confirm": {
      const confirmed = await context.ui.confirm(title, request.message, options);
      return { confirmed };
    }
    case "input": {
      const value = await context.ui.input(title, request.placeholder, options);
      return value === undefined ? { cancelled: true } : { value };
    }
    case "editor": {
      const value = await context.ui.editor(title, request.prefill);
      return value === undefined ? { cancelled: true } : { value };
    }
  }
}

function isDialog(request: ChildUiRequest): request is ChildDialogRequest {
  if (!request || typeof request !== "object") return false;
  const method = (request as { method?: string }).method;
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

function safeNotify(
  context: ExtensionContext | undefined,
  message: string,
  type: "info" | "warning" | "error",
): void {
  try {
    if (context?.hasUI) context.ui.notify(message, type);
  } catch {
    // The parent UI may already be tearing down.
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
