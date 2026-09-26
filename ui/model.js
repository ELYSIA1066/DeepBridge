const states = {
  TASK_STATE_SUBMITTED: { label: "已提交", tone: "neutral" },
  TASK_STATE_WORKING: { label: "处理中", tone: "active" },
  TASK_STATE_COMPLETED: { label: "已完成", tone: "success" },
  TASK_STATE_REJECTED: { label: "已拒绝", tone: "warning" },
  TASK_STATE_FAILED: { label: "失败", tone: "error" },
  TASK_STATE_CANCELED: { label: "已取消", tone: "neutral" },
};

export function taskState(task) {
  return states[task?.status?.state] ?? { label: "未知状态", tone: "neutral" };
}

export function isActive(task) {
  return task?.status?.state === "TASK_STATE_SUBMITTED" ||
    task?.status?.state === "TASK_STATE_WORKING";
}

export function taskTime(task) {
  return typeof task?.status?.timestamp === "string" ? task.status.timestamp : "";
}

export function shortId(id, length = 8) {
  return typeof id === "string" && id ? id.slice(0, length) : "—";
}

export function contextLabel(id) {
  if (!id || id === "未指定上下文") return "未指定上下文";
  if (/^[\da-f]{8}-[\da-f-]{27,}$/i.test(id)) return "上下文 " + shortId(id);
  const words = id
    .split(/[\s:/_-]+/)
    .filter(Boolean)
    .filter((word, index) => !(index === 0 && /^(ctx|context)$/i.test(word)))
    .slice(0, 4)
    .map((word) => {
      if (/^v\d/i.test(word) || /^t\d+$/i.test(word)) return word.toUpperCase();
      return word.length > 1 ? word[0].toUpperCase() + word.slice(1) : word.toUpperCase();
    });
  return words.length ? words.join(" · ") : "上下文 " + shortId(id);
}

export function compareTasksNewestFirst(left, right) {
  return taskTime(right).localeCompare(taskTime(left)) ||
    String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

export function textParts(parts) {
  return Array.isArray(parts)
    ? parts.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n")
    : "";
}

export function lastUserText(task) {
  const history = Array.isArray(task?.history) ? task.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "ROLE_USER") return textParts(history[index].parts);
  }
  return "";
}

export function resultText(task) {
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  return artifacts.map((artifact) => textParts(artifact.parts)).filter(Boolean).join("\n");
}

export function statusText(task) {
  return textParts(task?.status?.message?.parts);
}

export function taskIdFromSearch(search) {
  return new URLSearchParams(search).get("task") || null;
}

export function urlForTask(href, taskId) {
  const url = new URL(href);
  if (taskId) url.searchParams.set("task", taskId);
  else url.searchParams.delete("task");
  return url.href;
}

export function chooseSelectedTaskId(visibleTasks, selectedTaskId, pinnedTaskId) {
  if (pinnedTaskId && pinnedTaskId === selectedTaskId) return selectedTaskId;
  if (selectedTaskId && visibleTasks.some((task) => task.id === selectedTaskId)) {
    return selectedTaskId;
  }
  return visibleTasks[0]?.id ?? null;
}

export function contextGroups(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const id = typeof task.contextId === "string" && task.contextId
      ? task.contextId
      : "未指定上下文";
    const group = groups.get(id) ?? [];
    group.push(task);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, items]) => ({ id, tasks: items.sort(compareTasksNewestFirst) }))
    .sort((left, right) => compareTasksNewestFirst(left.tasks[0], right.tasks[0]));
}
