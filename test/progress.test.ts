import { describe, expect, it } from "vitest";
import { TaskProgressStore } from "../app/progress.js";

describe("TaskProgressStore", () => {
  it("keeps task timelines separate, coalesces text, and correlates tool status", () => {
    const store = new TaskProgressStore();
    store.start("task-a");
    store.start("task-b");
    store.add("task-a", { kind: "assistant", text: "Hello " });
    store.add("task-a", { kind: "assistant", text: "world" });
    store.add("task-a", {
      kind: "tool", toolCallId: "tool-1", title: "read_file", status: "in_progress",
    });
    store.add("task-a", { kind: "tool", toolCallId: "tool-1", status: "completed" });
    store.add("task-b", { kind: "assistant", text: "Other task" });

    expect(store.get("task-a")?.events).toMatchObject([
      { seq: 1, kind: "assistant", text: "Hello world" },
      { seq: 2, kind: "tool", title: "read_file", status: "in_progress" },
      { seq: 3, kind: "tool", title: "read_file", status: "completed" },
    ]);
    expect(store.get("task-b")?.events).toMatchObject([
      { seq: 1, kind: "assistant", text: "Other task" },
    ]);
    store.finish("task-a");
    store.add("task-a", { kind: "assistant", text: "late" });
    expect(store.get("task-a")?.events).toHaveLength(3);
  });

  it("bounds event count and display text without changing other tasks", () => {
    const store = new TaskProgressStore();
    store.start("many");
    for (let index = 0; index < 105; index += 1) {
      store.add("many", {
        kind: "tool", toolCallId: `tool-${index}`, title: `tool-${index}`, status: "completed",
      });
    }
    const many = store.get("many");
    expect(many?.events).toHaveLength(100);
    expect(many?.events[0]?.seq).toBe(6);
    expect(many?.truncated).toBe(true);

    store.start("long");
    store.add("long", { kind: "assistant", text: "x".repeat(70_000) });
    const long = store.get("long");
    expect(long?.truncated).toBe(true);
    expect(long?.events[0]?.kind).toBe("assistant");
    if (long?.events[0]?.kind === "assistant") {
      expect(Buffer.byteLength(long.events[0].text)).toBeLessThanOrEqual(64 * 1024);
    }
    store.start("unicode");
    store.add("unicode", { kind: "assistant", text: "界".repeat(30_000) });
    const unicode = store.get("unicode")?.events[0];
    expect(unicode?.kind).toBe("assistant");
    if (unicode?.kind === "assistant") {
      expect(unicode.text).not.toContain("�");
      expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(64 * 1024);
    }
    expect(store.get("many")?.events).toHaveLength(100);
  });

  it("does not expose internal tool IDs or raw fields and clears on shutdown", () => {
    const store = new TaskProgressStore();
    store.start("task");
    store.add("task", {
      kind: "tool", toolCallId: "private-id", title: "search", status: "in_progress",
      rawInput: "private-data",
    } as never);
    expect(JSON.stringify(store.get("task"))).not.toContain("private-id");
    expect(JSON.stringify(store.get("task"))).not.toContain("private-data");
    store.clear();
    expect(store.get("task")).toBeUndefined();
  });
});
