import { describe, expect, it } from "vitest";
import {
  chooseSelectedTaskId,
  contextLabel,
  contextGroups,
  isActive,
  lastUserText,
  resultText,
  statusText,
  shortId,
  taskIdFromSearch,
  taskState,
  urlForTask,
} from "../ui/model.js";

function task(id, contextId, state, timestamp, input = "") {
  return {
    id,
    contextId,
    status: { state, timestamp },
    history: [{ role: "ROLE_USER", parts: [{ text: input }] }],
    artifacts: [],
  };
}

describe("dashboard task projection", () => {
  it("reads and encodes task links without changing other query parameters", () => {
    expect(taskIdFromSearch("?task=older%2Ftask")).toBe("older/task");
    expect(taskIdFromSearch("")).toBeNull();
    expect(urlForTask("http://127.0.0.1:41241/ui/?view=all", "older/task"))
      .toBe("http://127.0.0.1:41241/ui/?view=all&task=older%2Ftask");
    expect(urlForTask("http://127.0.0.1:41241/ui/?task=old", null))
      .toBe("http://127.0.0.1:41241/ui/");
  });

  it("keeps a linked task selected when it is outside the latest page", () => {
    const latestPage = Array.from({ length: 100 }, (_, index) => ({ id: `recent-${index}` }));
    expect(chooseSelectedTaskId(latestPage, "older-than-first-page", "older-than-first-page"))
      .toBe("older-than-first-page");
    expect(chooseSelectedTaskId(latestPage, "missing-without-link", null))
      .toBe("recent-0");
  });
  it("groups tasks by context and sorts newest first", () => {
    const groups = contextGroups([
      task("a-old", "ctx-a", "TASK_STATE_COMPLETED", "2026-01-01T00:00:00Z"),
      task("b", "ctx-b", "TASK_STATE_WORKING", "2026-01-03T00:00:00Z"),
      task("a-new", "ctx-a", "TASK_STATE_COMPLETED", "2026-01-02T00:00:00Z"),
    ]);

    expect(groups.map((group) => group.id)).toEqual(["ctx-b", "ctx-a"]);
    expect(groups[1].tasks.map((item) => item.id)).toEqual(["a-new", "a-old"]);
  });

  it("gives readable context labels while keeping a short exact identifier", () => {
    expect(contextLabel("ctx-v04-reality-t7-cancel")).toBe("V04 · Reality · T7 · Cancel");
    expect(contextLabel("12345678-90ab-cdef-1234-567890abcdef")).toBe("上下文 12345678");
    expect(shortId("12345678-90ab-cdef", 13)).toBe("12345678-90ab");
  });

  it("reads the last user message, final artifact, and terminal explanation", () => {
    const item = task("a", "ctx-a", "TASK_STATE_REJECTED", "2026-01-01T00:00:00Z", "first");
    item.history.push({ role: "ROLE_USER", parts: [{ text: "<script>alert(1)</script>" }] });
    item.artifacts.push({ parts: [{ text: "Final result" }] });
    item.status.message = { parts: [{ text: "Permission denied" }] };

    expect(lastUserText(item)).toBe("<script>alert(1)</script>");
    expect(resultText(item)).toBe("Final result");
    expect(statusText(item)).toBe("Permission denied");
  });

  it("labels all terminal states and identifies active tasks", () => {
    expect(taskState(task("a", "x", "TASK_STATE_COMPLETED", "")).label).toBe("已完成");
    expect(taskState(task("a", "x", "TASK_STATE_REJECTED", "")).label).toBe("已拒绝");
    expect(taskState(task("a", "x", "TASK_STATE_FAILED", "")).label).toBe("失败");
    expect(taskState(task("a", "x", "TASK_STATE_CANCELED", "")).label).toBe("已取消");
    expect(isActive(task("a", "x", "TASK_STATE_WORKING", ""))).toBe(true);
    expect(isActive(task("a", "x", "TASK_STATE_COMPLETED", ""))).toBe(false);
  });
});
