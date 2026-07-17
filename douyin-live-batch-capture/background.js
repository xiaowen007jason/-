const JOB_KEY = "captureJob";
const ALARM_NAME = "douyinBatchCaptureStep";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePart(value, fallback = "未命名") {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  return cleaned || fallback;
}

function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function getJob() {
  const data = await chrome.storage.local.get(JOB_KEY);
  return data[JOB_KEY] || null;
}

async function setJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
  return job;
}

async function broadcastStatus(job) {
  try {
    await chrome.runtime.sendMessage({ type: "JOB_STATUS", job });
  } catch (_error) {
    // The popup is often closed during navigation; storage remains the source of truth.
  }
}

async function updateJob(patch) {
  const current = await getJob();
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await setJob(next);
  await broadcastStatus(next);
  return next;
}

function scheduleStep(delaySeconds) {
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + Math.max(1, delaySeconds) * 1000 });
}

async function safeSend(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function ensureContentReady(tabId, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await safeSend(tabId, { type: "PING" });
    if (response?.ok) return response;
    await wait(600);
  }
  throw new Error("页面脚本未就绪，请确认页面是抖音直播间。 ");
}

async function captureCurrentRoom(job) {
  const room = job.rooms[job.index];
  const tab = await chrome.tabs.get(job.tabId);
  if (!tab || tab.windowId !== job.windowId) throw new Error("用于截图的标签页已关闭或移动。 ");

  await ensureContentReady(job.tabId);
  let dataUrl = null;
  let prepared = false;
  let captureMethod = "screen-viewport";
  let screenError = null;

  try {
    if (job.options.outputMode !== "source") {
      const prepareResult = await safeSend(job.tabId, { type: "PREPARE_CAPTURE" });
      if (prepareResult?.ok) {
        prepared = true;
        await wait(600);
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(job.windowId, {
            format: job.options.format,
            quality: job.options.format === "jpeg" ? job.options.quality : undefined
          });
        } catch (error) {
          screenError = error.message;
        }
      } else {
        screenError = prepareResult?.error || "无法准备副屏直播画面。";
      }
    }
  } finally {
    if (prepared) await safeSend(job.tabId, { type: "RESTORE_CAPTURE" });
  }

  if (!dataUrl) {
    const nativeFrame = await safeSend(job.tabId, {
      type: "CAPTURE_NATIVE_FRAME",
      options: {
        format: job.options.format,
        quality: job.options.quality / 100,
        scale: job.options.outputMode === "source" ? 1 : 2
      }
    });
    if (!nativeFrame?.ok) {
      throw new Error(`副屏截图失败：${screenError || "未启用"}；直播源截图也失败：${nativeFrame?.error || "未知原因"}`);
    }
    dataUrl = nativeFrame.dataUrl;
    captureMethod = nativeFrame.method;
  }

  const now = new Date();
  const brand = sanitizePart(job.options.brand, "未分类品牌");
  const roomName = sanitizePart(room.name, `直播间${job.index + 1}`);
  const extension = job.options.format === "png" ? "png" : "jpg";
  const filename = [
    sanitizePart(job.options.rootFolder, "直播间截图"),
    brand,
    formatDate(now),
    `${String(job.index + 1).padStart(2, "0")}_${brand}_${roomName}_${formatDate(now)}_${formatTime(now)}.${extension}`
  ].join("/");

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });
  return { filename, captureMethod };
}

async function navigateToCurrent(job) {
  const room = job.rooms[job.index];
  await chrome.tabs.update(job.tabId, { url: room.url, active: true });
  await chrome.windows.update(job.windowId, { focused: true });
  const jitter = Math.floor(Math.random() * (job.options.jitterSeconds + 1));
  await updateJob({
    phase: "waiting",
    message: `正在打开 ${room.name}，等待直播画面加载……`,
    currentRoom: room,
    nextStepAt: Date.now() + (job.options.waitSeconds + jitter) * 1000
  });
  scheduleStep(job.options.waitSeconds + jitter);
}

async function finishJob(job, phase = "completed", message = "批量截图完成。") {
  chrome.alarms.clear(ALARM_NAME);
  if (phase === "completed" && job.options.returnToSearch && job.originalUrl) {
    try {
      await chrome.tabs.update(job.tabId, { url: job.originalUrl, active: true });
    } catch (_error) {
      // The screenshots are still complete even if returning to the source page fails.
    }
  }
  await updateJob({ phase, message, finishedAt: Date.now(), currentRoom: null });
}

async function processStep() {
  let job = await getJob();
  if (!job || !["waiting", "capturing", "navigating"].includes(job.phase)) return;
  if (job.cancelRequested) {
    await finishJob(job, "cancelled", "任务已停止。 ");
    return;
  }
  if (job.index >= job.rooms.length) {
    await finishJob(job);
    return;
  }

  try {
    job = await updateJob({
      phase: "capturing",
      message: `正在截图：${job.rooms[job.index].name}`
    });
    const captureResult = await captureCurrentRoom(job);
    const completed = [...job.completed, {
      ...job.rooms[job.index],
      filename: captureResult.filename,
      captureMethod: captureResult.captureMethod,
      capturedAt: Date.now()
    }];
    const nextIndex = job.index + 1;
    job = await updateJob({
      completed,
      index: nextIndex,
      phase: nextIndex >= job.rooms.length ? "completed" : "navigating",
      message: `已保存高清截图：${captureResult.filename}`,
      lastError: null
    });

    if (nextIndex >= job.rooms.length) {
      await finishJob(job);
    } else {
      await navigateToCurrent(job);
    }
  } catch (error) {
    const room = job.rooms[job.index];
    const retryCount = (job.retryCounts?.[room.url] || 0) + 1;
    const retryCounts = { ...(job.retryCounts || {}), [room.url]: retryCount };

    if (retryCount <= job.options.maxRetries) {
      await updateJob({
        phase: "waiting",
        retryCounts,
        lastError: error.message,
        message: `${room.name} 截图失败，准备第 ${retryCount} 次重试：${error.message}`
      });
      await chrome.tabs.reload(job.tabId);
      scheduleStep(job.options.waitSeconds + 2);
      return;
    }

    const failed = [...job.failed, { ...room, error: error.message, failedAt: Date.now() }];
    const nextIndex = job.index + 1;
    job = await updateJob({
      failed,
      retryCounts,
      index: nextIndex,
      lastError: error.message,
      phase: nextIndex >= job.rooms.length ? "completed" : "navigating",
      message: `${room.name} 已跳过：${error.message}`
    });

    if (nextIndex >= job.rooms.length) await finishJob(job, "completed", "任务完成，部分直播间截图失败。 ");
    else await navigateToCurrent(job);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) processStep();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_JOB") {
    getJob().then((job) => sendResponse({ ok: true, job }));
    return true;
  }

  if (message?.type === "START_JOB") {
    (async () => {
      const activeTab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!activeTab?.id || !activeTab.windowId) throw new Error("没有找到当前浏览器标签页。 ");
      if (!Array.isArray(message.rooms) || message.rooms.length === 0) throw new Error("请先收集并选择直播间。 ");

      const options = {
        brand: sanitizePart(message.options?.brand, "未分类品牌"),
        rootFolder: sanitizePart(message.options?.rootFolder, "直播间截图"),
        waitSeconds: Math.min(Math.max(Number(message.options?.waitSeconds) || 7, 3), 60),
        jitterSeconds: Math.min(Math.max(Number(message.options?.jitterSeconds) || 3, 0), 20),
        maxRetries: Math.min(Math.max(Number(message.options?.maxRetries) || 1, 0), 3),
        outputMode: message.options?.outputMode === "source" ? "source" : "screen",
        format: message.options?.format === "png" ? "png" : "jpeg",
        quality: Math.min(Math.max(Number(message.options?.quality) || 100, 80), 100),
        returnToSearch: message.options?.returnToSearch !== false
      };

      const job = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        rooms: message.rooms,
        index: 0,
        completed: [],
        failed: [],
        retryCounts: {},
        tabId: activeTab.id,
        windowId: activeTab.windowId,
        originalUrl: activeTab.url,
        options,
        phase: "navigating",
        message: "正在启动批量截图……",
        cancelRequested: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await setJob(job);
      await broadcastStatus(job);
      await navigateToCurrent(job);
      return job;
    })()
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_JOB") {
    (async () => {
      const job = await updateJob({ cancelRequested: true, message: "正在停止任务……" });
      chrome.alarms.clear(ALARM_NAME);
      if (job) await finishJob(job, "cancelled", "任务已停止。 ");
      return job;
    })().then((job) => sendResponse({ ok: true, job }));
    return true;
  }

  return false;
});
