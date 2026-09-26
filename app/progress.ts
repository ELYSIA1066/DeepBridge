export type DshProgressUpdate =
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
    };

export type TaskProgressEvent =
  | { seq: number; at: string; kind: "assistant"; text: string }
  | {
      seq: number;
      at: string;
      kind: "tool";
      title: string;
      status: "pending" | "in_progress" | "completed" | "failed";
    };

export type TaskProgressSnapshot = {
  taskId: string;
  events: TaskProgressEvent[];
  truncated: boolean;
};

type TaskProgressEntry = {
  events: TaskProgressEvent[];
  nextSeq: number;
  truncated: boolean;
  terminal: boolean;
  toolTitles: Map<string, string>;
};

const MAX_EVENTS = 100;
const MAX_DISPLAY_BYTES = 64 * 1024;
const MAX_TOOL_TITLE_LENGTH = 200;

export class TaskProgressStore {
  private readonly tasks = new Map<string, TaskProgressEntry>();

  start(taskId: string): void {
    if (this.tasks.has(taskId)) return;
    this.tasks.set(taskId, {
      events: [],
      nextSeq: 1,
      truncated: false,
      terminal: false,
      toolTitles: new Map(),
    });
  }

  add(taskId: string, update: DshProgressUpdate): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.terminal) return;

    if (update.kind === "assistant") {
      if (!update.text) return;
      const last = entry.events.at(-1);
      if (last?.kind === "assistant") {
        last.text += update.text;
      } else {
        entry.events.push({
          seq: entry.nextSeq++,
          at: new Date().toISOString(),
          kind: "assistant",
          text: update.text,
        });
      }
    } else {
      const title = update.title?.trim().slice(0, MAX_TOOL_TITLE_LENGTH)
        || entry.toolTitles.get(update.toolCallId)
        || "工具调用";
      if (update.status === "pending" || update.status === "in_progress") {
        if (!entry.toolTitles.has(update.toolCallId) && entry.toolTitles.size >= MAX_EVENTS) {
          const oldest = entry.toolTitles.keys().next().value;
          if (oldest) entry.toolTitles.delete(oldest);
        }
        entry.toolTitles.set(update.toolCallId, title);
      } else {
        entry.toolTitles.delete(update.toolCallId);
      }
      entry.events.push({
        seq: entry.nextSeq++,
        at: new Date().toISOString(),
        kind: "tool",
        title,
        status: update.status,
      });
    }

    this.limit(entry);
  }

  finish(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.terminal = true;
      entry.toolTitles.clear();
    }
  }

  get(taskId: string): TaskProgressSnapshot | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    return {
      taskId,
      events: entry.events.map((event) => ({ ...event })),
      truncated: entry.truncated,
    };
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId);
  }

  clear(): void {
    this.tasks.clear();
  }

  private limit(entry: TaskProgressEntry): void {
    const bytes = () => entry.events.reduce((total, event) =>
      total + Buffer.byteLength(event.kind === "assistant" ? event.text : event.title), 0);

    while (entry.events.length > MAX_EVENTS ||
      (entry.events.length > 1 && bytes() > MAX_DISPLAY_BYTES)) {
      entry.events.shift();
      entry.truncated = true;
    }

    const only = entry.events[0];
    if (only?.kind === "assistant" && bytes() > MAX_DISPLAY_BYTES) {
      const buffer = Buffer.from(only.text);
      let start = buffer.length - MAX_DISPLAY_BYTES;
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
      only.text = buffer.subarray(start).toString("utf8");
      entry.truncated = true;
    }
  }
}
