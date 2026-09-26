import { afterEach, describe, expect, it, vi } from "vitest";

class TestElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = "";
    this.value = "";
    this.scrollTop = 0;
    this.style = {};
    this.disabled = false;
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get lastChild() {
    return this.children.at(-1) ?? null;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this._text = "";
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(name, handler) { this.listeners.set(name, handler); }
  click() { this.listeners.get("click")?.(); }
  querySelectorAll(selector) {
    return descendants(this).filter((node) => {
      if (selector === "button[data-task-id]") return node.tag === "button" && node.dataset.taskId !== undefined;
      if (selector === "button[data-context-id]") return node.tag === "button" && node.dataset.contextId !== undefined;
      return false;
    });
  }
  focus() {}
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function findNode(node, predicate) {
  return descendants(node).find(predicate);
}

function findNodes(node, predicate) {
  return descendants(node).filter(predicate);
}

function task(id, minute) {
  return {
    id,
    contextId: "shared-context",
    status: { state: "TASK_STATE_COMPLETED", timestamp: new Date(Date.UTC(2026, 8, 24, 12, minute)).toISOString() },
    history: [{ role: "ROLE_USER", parts: [{ text: `Input ${id}` }] }],
    artifacts: [{ parts: [{ text: `Result ${id}` }] }],
  };
}

async function loadDashboard(taskId, getTaskResult, options = {}) {
  vi.resetModules();
  const instanceRef = options.instanceRef ?? { value: "instance-1" };
  const intervals = [];
  const elements = new Map();
  const connection = new TestElement();
  connection.append(new TestElement(), new TestElement());
  elements.set("connection", connection);
  for (const name of ["overview", "timeline", "raw"]) {
    const tab = new TestElement("button");
    tab.dataset.tab = name;
    elements.set("tab-" + name, tab);
  }
  const document = {
    hidden: false,
    activeElement: null,
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new TestElement());
      return elements.get(id);
    },
    createElement: (tag) => new TestElement(tag),
    addEventListener: () => undefined,
  };
  const window = {
    location: {
      search: `?task=${encodeURIComponent(taskId)}`,
      href: `http://127.0.0.1:41241/ui/?task=${encodeURIComponent(taskId)}`,
    },
    history: { replaceState: vi.fn() },
  };
  const recent = options.recentTasks ?? Array.from({ length: 100 }, (_, index) => task(`recent-${index}`, 59 - index % 60));
  const methods = [];
  const requests = [];
  const fetch = vi.fn(async (url, requestOptions) => {
    if (String(url).startsWith("/ui/api/tasks/")) {
      const id = decodeURIComponent(String(url).split("/tasks/")[1].split("/progress")[0]);
      const progress = await options.progressForTask?.(id) ?? { taskId: id, events: [], truncated: false };
      return progress instanceof Response ? progress : new Response(JSON.stringify(progress), {
        headers: { "Content-Type": "application/json", "X-Bridge-Instance": instanceRef.value },
      });
    }
    const request = JSON.parse(requestOptions.body);
    methods.push(request.method);
    requests.push(request);
    const body = request.method === "GetTask"
      ? typeof getTaskResult === "function" ? getTaskResult(request.params.id) : getTaskResult
      : { result: { tasks: recent, totalSize: recent.length + 1, nextPageToken: "more" } };
    const responseBody = structuredClone(body);
    const historyLength = request.params?.historyLength;
    if (Number.isInteger(historyLength) && historyLength > 0) {
      if (Array.isArray(responseBody.result?.history)) {
        responseBody.result.history = responseBody.result.history.slice(-historyLength);
      }
      for (const listedTask of responseBody.result?.tasks ?? []) {
        if (Array.isArray(listedTask.history)) listedTask.history = listedTask.history.slice(-historyLength);
      }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...responseBody }), {
      headers: { "Content-Type": "application/json", "X-Bridge-Instance": instanceRef.value },
    });
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("setInterval", (callback) => { intervals.push(callback); return 0; });

  await import("../ui/app.js");
  await vi.waitFor(() => expect(methods).toContain("ListTasks"));
  return { elements, methods, requests, window, fetch, document, intervals, instanceRef };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("dashboard task links", () => {
  it("reads a linked task before the first page and keeps an older task selected", async () => {
    const older = task("older-than-first-page", 0);
    const { elements, methods } = await loadDashboard(older.id, { result: older });

    expect(methods.slice(0, 2)).toEqual(["GetTask", "ListTasks"]);
    expect(elements.get("task-detail").textContent).toContain("Result older-than-first-page");
    const selected = findNode(elements.get("task-list"), (button) =>
      button.dataset.taskId === older.id);
    expect(selected?.attributes.get("aria-current")).toBe("true");
    const selectedContext = findNode(elements.get("context-list"), (button) =>
      button.dataset.contextId === older.contextId);
    expect(selectedContext?.attributes.get("aria-current")).toBe("true");
  });

  it("keeps failed task input visible alongside its terminal error", async () => {
    const failed = task("failed-task", 12);
    failed.status = {
      state: "TASK_STATE_FAILED",
      timestamp: "2026-09-24T12:12:00.000Z",
      message: { parts: [{ text: "DSH prompt exceeded 120000 ms." }] },
    };
    failed.history.push({
      role: "ROLE_AGENT",
      parts: [{ text: "DSH prompt exceeded 120000 ms." }],
    });
    failed.artifacts = [];

    const { elements, requests } = await loadDashboard(failed.id, { result: failed }, {
      recentTasks: [failed],
    });

    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("Input failed-task"));
    expect(elements.get("task-detail").textContent).toContain("DSH prompt exceeded 120000 ms.");
    expect(findNode(elements.get("task-list"), (button) =>
      button.dataset.taskId === failed.id)?.textContent).toContain("Input failed-task");
    expect(requests.map(({ method, params }) => [method, params?.historyLength])).toEqual(
      expect.arrayContaining([["ListTasks", 2], ["GetTask", 2]]),
    );
  });

  it("shows an expired-link message without selecting a different task", async () => {
    const { elements } = await loadDashboard("missing-after-restart", {
      error: { code: -32001, message: "Task not found" },
    });

    expect(elements.get("task-detail").textContent).toContain("任务已不存在");
    expect(elements.get("task-detail").textContent).not.toContain("Result recent-");
    expect(findNodes(elements.get("task-list"), (button) =>
      button.dataset.taskId !== undefined && button.attributes.get("aria-current") === "true").length).toBe(0);
  });

  it("keeps the all-context view after leaving a linked task", async () => {
    const linked = task("linked-task", 10);
    const other = { ...task("other-context-task", 11), contextId: "other-context" };
    const { elements } = await loadDashboard(linked.id,
      (id) => ({ result: id === linked.id ? linked : other }), {
        recentTasks: [other, linked],
      });

    await vi.waitFor(() => expect(findNode(elements.get("context-list"), (button) =>
      button.dataset.contextId === linked.contextId)?.attributes.get("aria-current")).toBe("true"));
    findNode(elements.get("context-list"), (button) => button.dataset.contextId === "").click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(findNode(elements.get("context-list"), (button) =>
      button.dataset.contextId === "")?.attributes.get("aria-current")).toBe("true");
    expect(elements.get("task-list").textContent).toContain(linked.id);
    expect(elements.get("task-list").textContent).toContain(other.id);
  });
});

describe("dashboard task progress", () => {
  it("renders the selected task's progress as text and keeps another task separate", async () => {
    const first = task("task-first", 1);
    const second = task("task-second", 2);
    const { elements } = await loadDashboard(first.id, (id) => ({ result: id === first.id ? first : second }), {
      recentTasks: [second, first],
      progressForTask: (id) => ({
        taskId: id,
        events: [{ seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text: `<b>${id}</b>` }],
        truncated: false,
      }),
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("<b>task-first</b>"));
    expect(elements.get("task-detail").textContent).not.toContain("<b>task-second</b>");
    expect(elements.get("task-detail").children[0].children.some((child) => child.tag === "b")).toBe(false);

    const secondButton = findNode(elements.get("task-list"), (button) => button.dataset.taskId === second.id);
    secondButton.click();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("<b>task-second</b>"));
    expect(elements.get("task-detail").textContent).not.toContain("<b>task-first</b>");
  });

  it("discards a late response for a previously selected task", async () => {
    const first = task("task-first", 1);
    const second = task("task-second", 2);
    let releaseFirst;
    const firstProgress = new Promise((resolve) => { releaseFirst = resolve; });
    const { elements } = await loadDashboard(first.id, (id) => ({ result: id === first.id ? first : second }), {
      recentTasks: [second, first],
      progressForTask: (id) => id === first.id
        ? firstProgress
        : { taskId: second.id, events: [
          { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text: "second-progress" },
        ], truncated: false },
    });
    await vi.waitFor(() => expect(findNode(elements.get("task-list"), (button) =>
      button.dataset.taskId === second.id)).toBeDefined());
    findNode(elements.get("task-list"), (button) => button.dataset.taskId === second.id).click();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("second-progress"));
    releaseFirst({ taskId: first.id, events: [
      { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text: "late-first-progress" },
    ], truncated: false });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).not.toContain("late-first-progress"));
  });

  it("refreshes visible progress and pauses polling while hidden", async () => {
    const current = task("task-current", 1);
    let text = "first-progress";
    const { elements, fetch, document, intervals } = await loadDashboard(current.id, { result: current }, {
      recentTasks: [current],
      progressForTask: (id) => ({ taskId: id, events: [
        { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text },
      ], truncated: false }),
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("first-progress"));
    text = "second-progress";
    intervals[0]();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("second-progress"));
    document.hidden = true;
    const callsBefore = fetch.mock.calls.length;
    intervals[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch.mock.calls.length).toBe(callsBefore);
  });

  it("drops old progress when the Bridge restarts and the linked task disappears", async () => {
    const current = task("task-current", 1);
    const instanceRef = { value: "instance-1" };
    const { elements, intervals } = await loadDashboard(current.id,
      () => instanceRef.value === "instance-1"
        ? { result: current }
        : { error: { code: -32001, message: "Task not found" } }, {
        recentTasks: [], instanceRef,
        progressForTask: (id) => ({ taskId: id, events: [
          { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text: "old-progress" },
        ], truncated: false }),
      });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("old-progress"));
    instanceRef.value = "instance-2";
    intervals[0]();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("任务已不存在"));
    expect(elements.get("task-detail").textContent).not.toContain("old-progress");
  });

  it("keeps a manually selected inspector tab during automatic refresh", async () => {
    const current = task("task-current", 1);
    let text = "first-progress";
    const { elements, intervals } = await loadDashboard(current.id, { result: current }, {
      recentTasks: [current],
      progressForTask: () => ({ taskId: current.id, events: [
        { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text },
      ], truncated: false }),
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("first-progress"));
    expect(elements.get("tab-timeline").attributes.get("aria-selected")).toBe("true");
    elements.get("tab-overview").click();
    expect(elements.get("tab-overview").attributes.get("aria-selected")).toBe("true");

    text = "second-progress";
    intervals[0]();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("最终结果"));
    expect(elements.get("tab-overview").attributes.get("aria-selected")).toBe("true");
  });

  it("renders the known tool and assistant fields and marks truncated progress", async () => {
    const current = task("task-tool", 1);
    const { elements } = await loadDashboard(current.id, { result: current }, {
      recentTasks: [current],
      progressForTask: () => ({ taskId: current.id, truncated: true, events: [
        { seq: 1, at: "2026-09-24T12:00:00Z", kind: "tool", title: "Read source", status: "completed" },
        { seq: 2, at: "2026-09-24T12:00:01Z", kind: "assistant", text: "Inspection finished." },
      ] }),
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("Inspection finished."));
    expect(elements.get("task-detail").textContent).toContain("Read source");
    expect(elements.get("task-detail").textContent).toContain("已完成");
    expect(elements.get("task-detail").textContent).toContain("64 KiB");
  });

  it("preserves all three pane scroll positions through repeated polling", async () => {
    const current = task("task-scroll", 1);
    let text = "before-refresh";
    const { elements, intervals } = await loadDashboard(current.id, { result: current }, {
      recentTasks: [current],
      progressForTask: () => ({ taskId: current.id, events: [
        { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text },
      ], truncated: false }),
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("before-refresh"));
    elements.get("context-list").scrollTop = 11;
    elements.get("task-list").scrollTop = 29;
    elements.get("task-detail").scrollTop = 47;
    text = "after-refresh";
    intervals[0]();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("after-refresh"));
    expect(elements.get("context-list").scrollTop).toBe(11);
    expect(elements.get("task-list").scrollTop).toBe(29);
    expect(elements.get("task-detail").scrollTop).toBe(47);
    text = "after-second-refresh";
    intervals[0]();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("after-second-refresh"));
    expect(elements.get("tab-timeline").attributes.get("aria-selected")).toBe("true");
  });

  it("shows the raw task and progress as escaped text", async () => {
    const current = task("task-raw", 1);
    current.history[0].parts[0].text = "<img src=x onerror=alert(1)>";
    const { elements } = await loadDashboard(current.id, { result: current }, {
      recentTasks: [current],
      progressForTask: () => ({ taskId: current.id, events: [
        { seq: 1, at: "2026-09-24T12:00:00Z", kind: "assistant", text: "<script>raw text</script>" },
      ], truncated: false }),
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("raw text"));
    elements.get("tab-raw").click();
    expect(elements.get("task-detail").textContent).toContain("<img src=x onerror=alert(1)>");
    expect(elements.get("task-detail").textContent).toContain("<script>raw text</script>");
    expect(findNodes(elements.get("task-detail"), (node) => node.tag === "img" || node.tag === "script")).toHaveLength(0);
  });

  it("copies an exact task ID and announces success", async () => {
    const current = task("task-copy-123", 1);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { elements } = await loadDashboard(current.id, { result: current }, {
      recentTasks: [current],
    });
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("task-copy-123"));
    findNode(elements.get("task-detail"), (node) => node.className === "copy-button").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("task-copy-123"));
    expect(elements.get("copy-announcement").textContent).toBe("已复制");
    findNode(elements.get("context-list"), (node) => node.className.includes("context-copy")).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("shared-context"));
  });

  it("filters contexts and task summaries without changing the selected task", async () => {
    const first = task("task-alpha", 1);
    const second = { ...task("task-beta", 2), contextId: "other-context" };
    const { elements } = await loadDashboard(first.id, (id) => ({ result: id === first.id ? first : second }), {
      recentTasks: [second, first],
    });
    await vi.waitFor(() => expect(elements.get("context-list").textContent).toContain("Other"));
    const contextSearch = elements.get("context-search");
    contextSearch.value = "other";
    contextSearch.listeners.get("input")({ target: contextSearch });
    expect(elements.get("context-list").textContent).toContain("Other");
    expect(elements.get("context-list").textContent).not.toContain("Shared");

    const taskSearch = elements.get("task-search");
    taskSearch.value = "no matching task";
    taskSearch.listeners.get("input")({ target: taskSearch });
    expect(elements.get("task-list").textContent).toContain("没有匹配任务");
    expect(elements.get("task-detail").textContent).toContain("Result task-alpha");
  });

  it("switches context and selects a task from that context", async () => {
    const first = task("task-alpha", 1);
    const second = { ...task("task-beta", 2), contextId: "other-context" };
    const { elements, window } = await loadDashboard(first.id,
      (id) => ({ result: id === first.id ? first : second }), {
        recentTasks: [second, first],
      });
    await vi.waitFor(() => expect(elements.get("context-list").textContent).toContain("Other"));
    findNode(elements.get("context-list"), (button) =>
      button.dataset.contextId === "other-context").click();
    await vi.waitFor(() => expect(elements.get("task-detail").textContent).toContain("Result task-beta"));
    expect(findNode(elements.get("context-list"), (button) =>
      button.dataset.contextId === "other-context").attributes.get("aria-current")).toBe("true");
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "http://127.0.0.1:41241/ui/?task=task-beta",
    );
  });
});
