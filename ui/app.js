import {
  chooseSelectedTaskId,
  compareTasksNewestFirst,
  contextGroups,
  contextLabel,
  isActive,
  lastUserText,
  resultText,
  shortId,
  statusText,
  taskIdFromSearch,
  taskState,
  taskTime,
  urlForTask,
} from "./model.js";

const elements = {
  connection: document.getElementById("connection"),
  connectionLabel: document.getElementById("connection-label"),
  refresh: document.getElementById("refresh"),
  loadMore: document.getElementById("load-more"),
  notice: document.getElementById("notice"),
  totalCount: document.getElementById("total-count"),
  activeCount: document.getElementById("active-count"),
  contextCount: document.getElementById("context-count"),
  headerContextCount: document.getElementById("header-context-count"),
  currentContext: document.getElementById("current-context"),
  updatedAt: document.getElementById("updated-at"),
  contextSearch: document.getElementById("context-search"),
  taskSearch: document.getElementById("task-search"),
  contextList: document.getElementById("context-list"),
  taskList: document.getElementById("task-list"),
  taskDetail: document.getElementById("task-detail"),
  visibleCount: document.getElementById("visible-count"),
  inspectorStatus: document.getElementById("inspector-status"),
  selectedTaskLabel: document.getElementById("selected-task-label"),
  copyAnnouncement: document.getElementById("copy-announcement"),
  timelineCount: document.getElementById("timeline-count"),
  tabs: {
    overview: document.getElementById("tab-overview"),
    timeline: document.getElementById("tab-timeline"),
    raw: document.getElementById("tab-raw"),
  },
};

const linkedTaskId = taskIdFromSearch(window.location.search);
let linkedTaskContextPending = Boolean(linkedTaskId);
const state = {
  tasks: new Map(),
  selectedContextId: null,
  selectedTaskId: linkedTaskId,
  pinnedTaskId: linkedTaskId,
  missingTaskId: null,
  instanceId: null,
  instanceEpoch: 0,
  nextPageToken: "",
  loadedOlderPages: false,
  totalSize: null,
  updatedAt: null,
  connection: "loading",
  message: "",
  refreshing: false,
  loadingMore: false,
  detailLoadingId: null,
  progressTaskId: null,
  progressEvents: [],
  progressTruncated: false,
  progressLoadingId: null,
  progressRequestSerial: 0,
  progressError: "",
  progressByTask: new Map(),
  inspectorTab: null,
  autoTabTaskId: null,
  autoTab: "overview",
  contextSearch: "",
  taskSearch: "",
  copyMessage: "",
  copyTimer: null,
};

let rpcId = 0;

async function callA2a(method, params) {
  const response = await fetch("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
    cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const body = await response.json();
  if (body?.error) {
    const error = new Error(body.error.message || "A2A 请求失败");
    error.code = body.error.code;
    error.instanceId = response.headers.get("X-Bridge-Instance");
    throw error;
  }
  if (!body || typeof body.result !== "object" || body.result === null) {
    throw new Error("A2A 返回了无效数据");
  }
  return { result: body.result, instanceId: response.headers.get("X-Bridge-Instance") };
}

function resetForInstance(instanceId) {
  state.tasks.clear();
  state.progressByTask.clear();
  clearProgress();
  state.instanceEpoch += 1;
  state.progressRequestSerial += 1;
  state.progressLoadingId = null;
  state.detailLoadingId = null;
  state.selectedContextId = null;
  state.selectedTaskId = state.pinnedTaskId;
  state.missingTaskId = null;
  state.nextPageToken = "";
  state.loadedOlderPages = false;
  state.totalSize = 0;
  state.instanceId = instanceId;
  state.autoTabTaskId = null;
}

function clearProgress(taskId = null) {
  state.progressTaskId = taskId;
  state.progressEvents = [];
  state.progressTruncated = false;
  state.progressError = "";
}

function activateProgress(taskId) {
  const snapshot = state.progressByTask.get(taskId);
  if (!snapshot) {
    clearProgress(taskId);
    return;
  }
  state.progressTaskId = taskId;
  state.progressEvents = snapshot.events;
  state.progressTruncated = snapshot.truncated;
  state.progressError = "";
}

function acceptInstance(instanceId) {
  if (!instanceId) return false;
  if (state.instanceId && state.instanceId !== instanceId) {
    resetForInstance(instanceId);
    return true;
  }
  if (!state.instanceId) state.instanceId = instanceId;
  return false;
}

function rememberTask(task) {
  if (typeof task?.id !== "string" || !task.id) return;
  const current = state.tasks.get(task.id);
  if (current && taskTime(task) < taskTime(current)) return;
  state.tasks.set(task.id, {
    ...current,
    ...task,
    artifacts: task.artifacts ?? current?.artifacts,
  });
}

async function refresh() {
  if (state.refreshing || state.loadingMore || document.hidden) return;
  state.refreshing = true;
  const requestEpoch = state.instanceEpoch;
  elements.refresh.disabled = true;
  render();

  try {
    const response = await callA2a("ListTasks", {
      tenant: "",
      pageSize: 100,
      historyLength: 2,
      includeArtifacts: false,
    });
    const result = response.result;
    if (!Array.isArray(result.tasks) || typeof result.totalSize !== "number") {
      throw new Error("任务列表格式无效");
    }
    if (requestEpoch !== state.instanceEpoch) return;
    acceptInstance(response.instanceId);
    if (result.totalSize < state.tasks.size) {
      state.tasks.clear();
      state.selectedTaskId = state.pinnedTaskId;
      state.missingTaskId = null;
      state.selectedContextId = null;
      state.loadedOlderPages = false;
    }
    for (const task of result.tasks) rememberTask(task);
    state.totalSize = result.totalSize;
    if (!state.loadedOlderPages) state.nextPageToken = result.nextPageToken || "";
    state.connection = "online";
    state.message = "";
    state.updatedAt = new Date();
    reconcileSelection();
    render();
    if (state.selectedTaskId) {
      void refreshDetail(state.selectedTaskId);
      void refreshProgress(state.selectedTaskId);
    }
  } catch (error) {
    state.connection = error instanceof TypeError ? "offline" : "error";
    state.message = state.connection === "offline"
      ? "无法连接到 Bridge。请确认服务正在运行；当前显示的是上次读取的数据。"
      : "读取任务失败：" + (error instanceof Error ? error.message : "未知错误");
  } finally {
    state.refreshing = false;
    elements.refresh.disabled = false;
    render();
  }
}

async function refreshDetail(taskId) {
  if (state.detailLoadingId === taskId || state.missingTaskId === taskId) return;
  state.detailLoadingId = taskId;
  const requestEpoch = state.instanceEpoch;
  render();
  try {
    const response = await callA2a("GetTask", {
      tenant: "",
      id: taskId,
      historyLength: 2,
    });
    if (requestEpoch !== state.instanceEpoch) return;
    const restarted = acceptInstance(response.instanceId);
    const task = response.result;
    if (task.id !== taskId) throw new Error("任务 ID 不匹配");
    rememberTask(task);
    state.missingTaskId = null;
    if (linkedTaskContextPending && taskId === linkedTaskId) {
      linkedTaskContextPending = false;
      if (state.selectedTaskId === taskId && state.pinnedTaskId === taskId &&
          typeof task.contextId === "string" && task.contextId) {
        state.selectedContextId = task.contextId;
      }
    }
    if (restarted) void refresh();
    if (state.selectedTaskId === taskId) void refreshProgress(taskId);
  } catch (error) {
    if (requestEpoch !== state.instanceEpoch) return;
    if (error?.instanceId) acceptInstance(error.instanceId);
    if (state.selectedTaskId === taskId) {
      if (error?.code === -32001) {
        state.missingTaskId = taskId;
      } else {
        state.message = "读取任务详情失败：" + (error instanceof Error ? error.message : "未知错误");
      }
    }
  } finally {
    if (state.detailLoadingId === taskId) state.detailLoadingId = null;
    render();
  }
}

async function refreshProgress(taskId) {
  if (!taskId || state.missingTaskId === taskId || state.progressLoadingId === taskId) return;
  state.progressLoadingId = taskId;
  const requestSerial = ++state.progressRequestSerial;
  const requestEpoch = state.instanceEpoch;
  if (state.progressTaskId !== taskId) activateProgress(taskId);
  try {
    const response = await fetch("/ui/api/tasks/" + encodeURIComponent(taskId) + "/progress", {
      cache: "no-store",
    });
    if (requestEpoch !== state.instanceEpoch) return;
    const instanceId = response.headers.get("X-Bridge-Instance");
    if (acceptInstance(instanceId)) {
      if (state.selectedTaskId === taskId) void refreshDetail(taskId);
      void refresh();
      return;
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    const result = await response.json();
    if (requestEpoch !== state.instanceEpoch) return;
    if (result?.taskId !== taskId || !Array.isArray(result.events)) {
      throw new Error("执行过程格式无效");
    }
    if (state.selectedTaskId !== taskId) return;
    state.progressTaskId = taskId;
    state.progressEvents = result.events;
    state.progressTruncated = result.truncated === true;
    state.progressError = "";
    const snapshot = { events: result.events, truncated: result.truncated === true };
    state.progressByTask.set(taskId, snapshot);
    if (!state.inspectorTab && state.autoTabTaskId !== taskId) {
      state.autoTabTaskId = taskId;
      state.autoTab = snapshot.events.length ? "timeline" : "overview";
    }
  } catch (error) {
    if (requestEpoch === state.instanceEpoch && state.selectedTaskId === taskId) {
      state.progressError = "读取执行过程失败：" + (error instanceof Error ? error.message : "未知错误");
    }
  } finally {
    if (requestSerial === state.progressRequestSerial) state.progressLoadingId = null;
    render();
  }
}

async function loadMore() {
  if (state.loadingMore || state.refreshing || !state.nextPageToken) return;
  state.loadingMore = true;
  const requestEpoch = state.instanceEpoch;
  const pageToken = state.nextPageToken;
  render();
  let reload = false;
  try {
    const response = await callA2a("ListTasks", {
      tenant: "",
      pageSize: 100,
      pageToken,
      historyLength: 1,
      includeArtifacts: false,
    });
    const result = response.result;
    if (!Array.isArray(result.tasks) || typeof result.totalSize !== "number") {
      throw new Error("任务列表格式无效");
    }
    if (requestEpoch !== state.instanceEpoch) return;
    if (acceptInstance(response.instanceId)) {
      reload = true;
    } else if (result.tasks.length === 0 && result.totalSize > state.tasks.size) {
      state.tasks.clear();
      state.nextPageToken = "";
      state.loadedOlderPages = false;
      state.selectedContextId = null;
      state.selectedTaskId = null;
      state.message = "任务顺序已更新，列表将从首页重新加载。";
      reload = true;
    } else {
      for (const task of result.tasks) rememberTask(task);
      state.totalSize = result.totalSize;
      state.nextPageToken = result.nextPageToken || "";
      state.loadedOlderPages = true;
      state.connection = "online";
      state.message = "";
      reconcileSelection();
    }
  } catch (error) {
    state.message = "加载更多失败：" + (error instanceof Error ? error.message : "未知错误");
  } finally {
    state.loadingMore = false;
    render();
  }
  if (reload) void refresh();
}

function allTasks() {
  return [...state.tasks.values()].sort(compareTasksNewestFirst);
}

function reconcileSelection() {
  const groups = contextGroups(allTasks());
  if (state.selectedContextId !== null && !groups.some((group) => group.id === state.selectedContextId)) {
    state.selectedContextId = null;
  }
  const visible = state.selectedContextId === null
    ? allTasks()
    : groups.find((group) => group.id === state.selectedContextId)?.tasks ?? [];
  state.selectedTaskId = chooseSelectedTaskId(visible, state.selectedTaskId, state.pinnedTaskId);
}

function selectTask(taskId) {
  if (!taskId) return;
  linkedTaskContextPending = false;
  if (state.selectedTaskId !== taskId) {
    state.pinnedTaskId = taskId;
    state.selectedTaskId = taskId;
    state.missingTaskId = null;
    activateProgress(taskId);
    window.history.replaceState(null, "", urlForTask(window.location.href, taskId));
  }
  render();
  void refreshDetail(taskId);
  void refreshProgress(taskId);
}

function selectContext(contextId) {
  linkedTaskContextPending = false;
  state.selectedContextId = contextId;
  state.pinnedTaskId = null;
  state.selectedTaskId = null;
  reconcileSelection();
  if (state.selectedTaskId) {
    window.history.replaceState(null, "", urlForTask(window.location.href, state.selectedTaskId));
  } else {
    window.history.replaceState(null, "", urlForTask(window.location.href, null));
  }
  activateProgress(state.selectedTaskId);
  render();
  if (state.selectedTaskId) {
    void refreshDetail(state.selectedTaskId);
    void refreshProgress(state.selectedTaskId);
  }
}

function jumpToTaskContext(task) {
  if (!task.contextId) return;
  state.selectedContextId = task.contextId;
  state.pinnedTaskId = task.id;
  state.selectedTaskId = task.id;
  window.history.replaceState(null, "", urlForTask(window.location.href, task.id));
  render();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyState(title, description, compact = false) {
  const container = element("div", compact ? "empty compact" : "empty");
  container.append(
    element("span", "empty-mark", "◇"),
    element("strong", "", title),
    element("p", "", description),
  );
  return container;
}

function statusPill(task) {
  const status = taskState(task);
  const pill = element("span", "status-pill", status.label);
  pill.dataset.tone = status.tone;
  return pill;
}

function displayTime(task) {
  const value = taskTime(task);
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : "时间未知";
}

function displayEventTime(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date)
    : "时间未知";
}

function progressFor(taskId) {
  if (state.progressTaskId === taskId) {
    return {
      events: state.progressEvents,
      truncated: state.progressTruncated,
    };
  }
  return state.progressByTask.get(taskId) ?? { events: [], truncated: false };
}

function progressCountText(taskId) {
  const snapshot = state.progressByTask.get(taskId);
  if (snapshot) return snapshot.events.length + " 条";
  return state.progressLoadingId === taskId ? "读取中" : "—";
}

function copyButton(value, accessibleName, label = "复制", extraClass = "") {
  const button = element("button", ("copy-button " + extraClass).trim(), label);
  button.type = "button";
  button.title = "复制" + accessibleName;
  button.setAttribute("aria-label", "复制" + accessibleName);
  button.addEventListener("click", () => void copyText(value));
  return button;
}

async function copyText(value) {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(value);
    } else {
      const field = document.createElement("textarea");
      field.value = value;
      field.readOnly = true;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand?.("copy");
      field.remove();
      if (!copied) throw new Error("clipboard unavailable");
    }
    state.copyMessage = "已复制";
  } catch {
    state.copyMessage = "复制失败，请手动选择";
  }
  elements.copyAnnouncement.textContent = state.copyMessage;
  if (state.copyTimer) clearTimeout(state.copyTimer);
  state.copyTimer = setTimeout(() => {
    state.copyMessage = "";
    elements.copyAnnouncement.textContent = "";
  }, 1800);
}

function renderContexts(groups, totalTaskCount) {
  const search = state.contextSearch.trim().toLocaleLowerCase();
  const visibleGroups = search
    ? groups.filter((group) => (group.id + " " + contextLabel(group.id)).toLocaleLowerCase().includes(search))
    : groups;
  const items = [];
  const allRow = element("div", "context-row");
  const allButton = element("button", "context-button");
  allButton.type = "button";
  allButton.setAttribute("aria-current", String(state.selectedContextId === null));
  allButton.dataset.contextId = "";
  allButton.append(
    element("span", "context-name-wrap", "全部任务"),
    element("span", "context-count", String(totalTaskCount)),
  );
  allButton.addEventListener("click", () => selectContext(null));
  allRow.append(allButton);
  items.push(allRow);

  for (const group of visibleGroups) {
    const row = element("div", "context-row");
    const button = element("button", "context-button");
    button.type = "button";
    button.title = group.id;
    button.dataset.contextId = group.id;
    button.setAttribute("aria-current", String(state.selectedContextId === group.id));
    const name = element("span", "context-name-wrap");
    const titleLine = element("span", "context-title-line");
    titleLine.append(element("span", "context-label", contextLabel(group.id)));
    if (group.tasks.some(isActive)) {
      const running = element("span", "context-running-dot");
      running.title = "此上下文有任务正在运行";
      running.setAttribute("aria-label", "有任务正在运行");
      titleLine.append(running);
    }
    name.append(titleLine, element("span", "context-short-id", shortId(group.id, 12)));
    button.append(name, element("span", "context-count", String(group.tasks.length)));
    button.addEventListener("click", () => selectContext(group.id));
    row.append(button, copyButton(group.id, "上下文 ID", "⧉", "context-copy"));
    items.push(row);
  }
  if (search && visibleGroups.length === 0) {
    items.push(emptyState("没有匹配上下文", "尝试搜索完整 ID 或上下文名称。", true));
  }
  elements.contextList.replaceChildren(...items);
}

function visibleTasks(groups) {
  const contextTasks = state.selectedContextId === null
    ? allTasks()
    : groups.find((group) => group.id === state.selectedContextId)?.tasks ?? [];
  const search = state.taskSearch.trim().toLocaleLowerCase();
  if (!search) return contextTasks;
  return contextTasks.filter((task) => {
    const progress = progressFor(task.id);
    const haystack = [
      task.id,
      task.contextId,
      contextLabel(task.contextId),
      taskState(task).label,
      lastUserText(task),
      resultText(task),
      statusText(task),
      progress.events.length ? String(progress.events.length) : "",
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(search);
  });
}

function renderTasks(tasks, taskCount) {
  elements.visibleCount.textContent = tasks.length + " / " + taskCount;
  if (state.connection === "loading" && tasks.length === 0 && !state.taskSearch) {
    elements.taskList.replaceChildren(emptyState("正在载入任务", "正在读取当前 Bridge 的运行期记录。"));
    return;
  }
  if (tasks.length === 0) {
    const title = state.taskSearch ? "没有匹配任务" :
      state.connection === "offline" ? "Bridge 暂不可用" : "当前还没有任务";
    const description = state.taskSearch
      ? "尝试其他输入内容、状态或任务 ID。"
      : state.connection === "offline"
        ? "启动 Bridge 后点击刷新即可查看任务。"
        : "通过 Codex 或其他 A2A 客户端提交任务后，会显示在这里。";
    elements.taskList.replaceChildren(emptyState(title, description));
    return;
  }

  elements.taskList.replaceChildren(...tasks.map((task) => {
    const card = element("article", "task-card");
    const button = element("button", "task-button");
    button.type = "button";
    button.title = task.id;
    button.dataset.taskId = task.id;
    button.setAttribute("aria-current", String(state.selectedTaskId === task.id));
    const top = element("span", "task-row-top");
    top.append(statusPill(task), element("time", "task-time", displayTime(task)));
    const summary = element("span", "task-preview", lastUserText(task) || "任务内容不可用");
    const meta = element("span", "task-meta");
    const context = task.contextId ? contextLabel(task.contextId) : "未指定上下文";
    const progress = progressFor(task.id);
    const progressKnown = state.progressByTask.has(task.id);
    const progressCount = progressKnown ? String(progress.events.length) : "—";
    meta.append(
      element("span", "task-meta-context", context),
      element("span", "task-event-count", shortId(task.id, 8) + " · " + progressCount + " 条过程"),
    );
    button.append(top, summary, meta);
    button.addEventListener("click", () => selectTask(task.id));
    card.append(button);
    return card;
  }));
}

function detailField(label, value, className = "") {
  const field = element("section", "detail-field");
  const heading = element("div", "field-heading");
  heading.append(element("span", "detail-label", label));
  field.append(heading, element("p", "detail-value " + className, value));
  return field;
}

function copyableValue(label, value, accessibleName, className = "mono") {
  const field = element("section", "detail-card");
  const heading = element("div", "field-heading");
  heading.append(element("span", "detail-label", label), copyButton(value, accessibleName));
  field.append(heading, element("p", "detail-value " + className, value));
  return field;
}

function contextReference(task) {
  const value = task.contextId || "未指定上下文";
  const field = element("section", "detail-card");
  const heading = element("div", "field-heading");
  heading.append(element("span", "detail-label", "任务上下文"));
  const actions = element("span", "field-actions");
  if (task.contextId) {
    const jump = element("button", "copy-button context-jump", "定位");
    jump.type = "button";
    jump.title = "在左侧上下文列表中定位";
    jump.addEventListener("click", () => jumpToTaskContext(task));
    actions.append(jump);
  }
  actions.append(copyButton(value, "上下文 ID"));
  heading.append(actions);
  const id = element("p", "detail-value mono", value);
  id.title = value;
  field.append(heading, id);
  return field;
}

function longTextBlock(text, className, summary) {
  if (text.length <= 1200) return element("div", className, text);
  const disclosure = element("details", "text-disclosure");
  disclosure.append(element("summary", "", summary), element("div", className, text));
  return disclosure;
}

function renderOverview(task) {
  const container = element("div", "overview");
  const status = taskState(task);
  const statusRow = element("div", "overview-status");
  statusRow.append(statusPill(task), element("span", "overview-updated", "A2A 状态时间 · " + displayTime(task)));
  container.append(statusRow);

  const explanation = statusText(task);
  const stateName = task?.status?.state;
  const hasTerminalExplanation = ["TASK_STATE_REJECTED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"].includes(stateName);
  if (explanation && !hasTerminalExplanation) {
    const note = element("p", "status-summary", explanation);
    if (status.tone === "warning" || status.tone === "error") note.dataset.tone = status.tone;
    container.append(note);
  }

  const grid = element("div", "detail-grid");
  grid.append(
    copyableValue("任务 ID", task.id, "任务 ID"),
    contextReference(task),
    copyableValue("开始时间", "A2A 未提供", "开始时间", ""),
    copyableValue("状态时间", displayTime(task), "状态时间", ""),
    copyableValue("任务耗时", "不可可靠计算", "任务耗时", ""),
    copyableValue("过程事件", progressCountText(task.id), "过程事件", ""),
  );
  container.append(grid);

  const userField = element("section", "detail-field");
  userField.append(element("h3", "overview-section-heading", "用户输入"));
  userField.append(longTextBlock(lastUserText(task) || "任务内容不可用", "input-block", "展开完整输入"));
  container.append(userField);

  if (stateName === "TASK_STATE_COMPLETED") {
    const resultField = element("section", "detail-field");
    resultField.append(element("h3", "overview-section-heading", "最终结果"));
    const result = resultText(task);
    resultField.append(result
      ? longTextBlock(result, "result-block", "展开完整结果")
      : element("div", "result-block empty-result", state.detailLoadingId === task.id ? "正在读取最终结果…" : "任务已完成，没有文本产物。"));
    container.append(resultField);
  } else if (["TASK_STATE_REJECTED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"].includes(stateName)) {
    const terminalLabels = {
      TASK_STATE_REJECTED: "拒绝说明",
      TASK_STATE_FAILED: "失败说明",
      TASK_STATE_CANCELED: "取消说明",
    };
    const terminalTone = {
      TASK_STATE_REJECTED: "warning",
      TASK_STATE_FAILED: "error",
      TASK_STATE_CANCELED: "neutral",
    };
    const note = element("p", "status-summary", explanation || "任务已结束，没有返回状态说明。");
    note.dataset.tone = terminalTone[stateName];
    const resultField = element("section", "detail-field");
    resultField.append(element("h3", "overview-section-heading", terminalLabels[stateName]), note);
    container.append(resultField);
  } else {
    container.append(detailField("当前状态", status.label));
  }

  return container;
}

function toolState(status) {
  const states = {
    pending: { label: "等待中", tone: "neutral" },
    in_progress: { label: "进行中", tone: "active" },
    completed: { label: "已完成", tone: "success" },
    failed: { label: "失败", tone: "error" },
  };
  return states[status] ?? { label: "状态更新", tone: "neutral" };
}

function renderTimeline(task) {
  const container = element("div", "timeline-wrap");
  const snapshot = progressFor(task.id);
  const events = snapshot.events.filter((event) => event?.kind === "assistant" || event?.kind === "tool");
  const summary = element("div", "timeline-summary");
  summary.append(
    element("span", "", events.length + " 条已提交的过程更新"),
    element("span", "", isActive(task) ? "任务仍在运行时自动刷新" : "任务已结束"),
  );
  container.append(summary);

  if (snapshot.truncated) {
    container.append(element(
      "p",
      "truncation-note",
      "Bridge 仅保留最近 100 条事件或 64 KiB 展示文本；较早过程可能已被移除或截断。最终产物不受此限制。",
    ));
  }
  if (!isActive(task) && task?.status?.state !== "TASK_STATE_COMPLETED") {
    const explanation = statusText(task);
    const taskStateNotice = element("div", "task-state-notice");
    taskStateNotice.append(
      statusPill(task),
      element("span", "task-state-caption", "A2A 任务状态"),
    );
    if (explanation) taskStateNotice.append(element("p", "task-state-message", explanation));
    container.append(taskStateNotice);
  }
  if (state.progressError && state.progressTaskId === task.id) {
    container.append(element("p", "progress-error", state.progressError));
  }
  if (!events.length) {
    const waiting = state.progressLoadingId === task.id;
    const title = waiting ? "正在读取执行过程" : "暂无执行过程记录";
    const description = waiting
      ? "正在读取 Bridge 已保存的 Harness 更新。"
      : isActive(task)
        ? "当前没有已保存的过程更新；任务状态仍以 A2A 任务记录为准。"
        : "Bridge 没有为此任务保存执行过程事件。";
    container.append(emptyState(title, description, true));
    return container;
  }

  const list = element("ol", "timeline-list");
  for (const event of events) {
    const assistant = event.kind === "assistant";
    const tool = assistant ? null : toolState(event.status);
    const item = element("li", "timeline-item");
    item.dataset.kind = assistant ? "assistant" : "tool";
    if (tool) item.dataset.tone = tool.tone;
    const marker = element("span", "timeline-marker", assistant ? "A" : "•");
    const card = element("div", "timeline-card");
    card.dataset.kind = assistant ? "assistant" : "tool";
    const head = element("div", "timeline-card-head");
    const titleText = assistant ? "助手消息" : (event.title || "工具调用");
    head.append(
      element("span", "timeline-title", titleText),
      element("time", "timeline-time", displayEventTime(event.at)),
    );
    if (tool) {
      const statusWrap = element("div", "tool-status");
      statusWrap.dataset.tone = tool.tone;
      statusWrap.textContent = tool.label;
      head.append(statusWrap);
    }
    card.append(head, element("p", "timeline-text", assistant ? (event.text || "") : titleText));
    item.append(marker, card);
    list.append(item);
  }
  container.append(list);
  return container;
}

function renderRaw(task) {
  const container = element("div", "raw-view");
  const toolbar = element("div", "raw-toolbar");
  const snapshot = progressFor(task.id);
  const raw = JSON.stringify({
    task,
    context: {
      id: task.contextId || null,
      label: contextLabel(task.contextId),
    },
    progress: {
      taskId: task.id,
      events: snapshot.events,
      truncated: snapshot.truncated,
    },
  }, null, 2);
  toolbar.append(
    element("span", "raw-caption", "当前客户端持有的 A2A Task 与进度快照"),
    copyButton(raw, "原始 JSON"),
  );
  container.append(toolbar, element("pre", "raw-json", raw));
  return container;
}

function activeTab(task) {
  if (state.inspectorTab) return state.inspectorTab;
  if (state.autoTabTaskId === task?.id) return state.autoTab;
  const progress = task ? progressFor(task.id) : { events: [] };
  return progress.events.length ? "timeline" : "overview";
}

function renderDetail() {
  const task = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : null;
  const missing = state.missingTaskId === state.selectedTaskId && Boolean(state.selectedTaskId);
  const selectedId = state.selectedTaskId;
  const status = task ? taskState(task) : null;
  elements.inspectorStatus.textContent = task ? status.label : missing ? "任务已不存在" : selectedId ? "正在读取" : "未选择任务";
  elements.selectedTaskLabel.replaceChildren();
  if (selectedId) {
    if (task) {
      const summary = lastUserText(task).split(/\r?\n/, 1)[0] || "无输入摘要";
      const preview = element("span", "selected-task-summary", summary);
      preview.title = lastUserText(task) || "无输入摘要";
      const shortTaskId = element("span", "selected-task-id", shortId(task.id));
      shortTaskId.title = task.id;
      elements.selectedTaskLabel.append(preview, shortTaskId, copyButton(task.id, "任务 ID"));
    } else {
      const linkedId = element("span", "selected-task-id", selectedId);
      linkedId.title = selectedId;
      elements.selectedTaskLabel.append(linkedId);
    }
  } else {
    elements.selectedTaskLabel.textContent = "从任务列表选择一项";
  }

  for (const [tabName, button] of Object.entries(elements.tabs)) {
    button.disabled = !task;
    button.setAttribute("aria-selected", String(Boolean(task) && activeTab(task) === tabName));
  }
  elements.timelineCount.textContent = task
    ? progressFor(task.id).events.length + " 条记录"
    : "0 条记录";

  if (!task) {
    const title = missing ? "任务已不存在" : selectedId
      ? state.detailLoadingId === selectedId ? "正在读取任务" : "任务详情暂不可用"
      : "选择一项任务";
    const description = missing
      ? "该链接对应的任务不在当前 Bridge 运行期记录中，可能已随 Bridge 重启而清空。"
      : selectedId
        ? state.detailLoadingId === selectedId ? "正在按任务 ID 读取详情。" : "请检查上方提示，或点击刷新重试。"
        : "从左侧选择任务，查看输入、状态和执行过程。";
    elements.taskDetail.replaceChildren(emptyState(title, description));
    return;
  }

  const tab = activeTab(task);
  elements.taskDetail.setAttribute("aria-labelledby", "tab-" + tab);
  if (tab === "timeline") elements.taskDetail.replaceChildren(renderTimeline(task));
  else if (tab === "raw") elements.taskDetail.replaceChildren(renderRaw(task));
  else elements.taskDetail.replaceChildren(renderOverview(task));
}

function render() {
  const focused = document.activeElement;
  const focusedTaskId = focused?.dataset?.taskId;
  const focusedContextId = focused?.dataset?.contextId;
  const scrollPositions = [
    elements.contextList.scrollTop,
    elements.taskList.scrollTop,
    elements.taskDetail.scrollTop,
  ];
  const tasks = allTasks();
  const groups = contextGroups(tasks);
  const visible = visibleTasks(groups);

  const connectionLabels = {
    loading: "正在连接",
    online: "Bridge 已连接",
    offline: "Bridge 不可达",
    error: "读取失败",
  };
  elements.connection.dataset.state = state.connection;
  elements.connectionLabel.textContent = connectionLabels[state.connection];
  elements.totalCount.textContent = state.totalSize === null ? "—" : String(state.totalSize);
  elements.activeCount.textContent = String(tasks.filter(isActive).length);
  elements.contextCount.textContent = String(groups.length);
  elements.headerContextCount.textContent = String(groups.length);
  elements.currentContext.textContent = state.selectedContextId
    ? contextLabel(state.selectedContextId)
    : "全部上下文";
  elements.updatedAt.textContent = state.updatedAt
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(state.updatedAt)
    : "—";
  elements.notice.hidden = !state.message;
  elements.notice.textContent = state.message;
  elements.loadMore.hidden = !state.nextPageToken;
  elements.loadMore.disabled = state.loadingMore || state.refreshing;
  elements.loadMore.textContent = state.loadingMore ? "正在加载…" : "加载更早任务";
  elements.copyAnnouncement.textContent = state.copyMessage;
  renderContexts(groups, tasks.length);
  renderTasks(visible, tasks.length);
  renderDetail();

  elements.contextList.scrollTop = scrollPositions[0];
  elements.taskList.scrollTop = scrollPositions[1];
  elements.taskDetail.scrollTop = scrollPositions[2];
  if (focusedTaskId !== undefined) {
    [...elements.taskList.querySelectorAll("button[data-task-id]")]
      .find((button) => button.dataset.taskId === focusedTaskId)?.focus({ preventScroll: true });
  } else if (focusedContextId !== undefined) {
    [...elements.contextList.querySelectorAll("button[data-context-id]")]
      .find((button) => button.dataset.contextId === focusedContextId)?.focus({ preventScroll: true });
  }
}

elements.refresh.addEventListener("click", () => void refresh());
elements.loadMore.addEventListener("click", () => void loadMore());
elements.contextSearch.addEventListener("input", (event) => {
  state.contextSearch = event.target.value;
  render();
});
elements.taskSearch.addEventListener("input", (event) => {
  state.taskSearch = event.target.value;
  render();
});
for (const button of Object.values(elements.tabs)) {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    state.inspectorTab = button.dataset.tab;
    render();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target?.matches?.("input, textarea, [contenteditable=true]")) return;
  event.preventDefault();
  elements.taskSearch.focus();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  if (!document.hidden) void refresh();
}, 3000);

render();
void (async () => {
  if (linkedTaskId) await refreshDetail(linkedTaskId);
  await refresh();
})();
