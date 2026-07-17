const elements = {
  brand: document.querySelector("#brand"),
  openSearch: document.querySelector("#openSearch"),
  scanRooms: document.querySelector("#scanRooms"),
  selectAll: document.querySelector("#selectAll"),
  selectNone: document.querySelector("#selectNone"),
  roomList: document.querySelector("#roomList"),
  roomSummary: document.querySelector("#roomSummary"),
  waitSeconds: document.querySelector("#waitSeconds"),
  jitterSeconds: document.querySelector("#jitterSeconds"),
  maxRetries: document.querySelector("#maxRetries"),
  outputMode: document.querySelector("#outputMode"),
  format: document.querySelector("#format"),
  rootFolder: document.querySelector("#rootFolder"),
  returnToSearch: document.querySelector("#returnToSearch"),
  statusBadge: document.querySelector("#statusBadge"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  resultStats: document.querySelector("#resultStats"),
  startJob: document.querySelector("#startJob"),
  stopJob: document.querySelector("#stopJob")
};

let rooms = [];

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setBusy(isBusy) {
  elements.scanRooms.disabled = isBusy;
  elements.openSearch.disabled = isBusy;
  elements.startJob.disabled = isBusy;
}

function selectedRooms() {
  const selected = new Set(
    Array.from(document.querySelectorAll(".room-select:checked")).map((input) => input.dataset.url)
  );
  return rooms.filter((room) => selected.has(room.url));
}

function updateSelectionSummary() {
  const selected = selectedRooms().length;
  elements.roomSummary.textContent = rooms.length
    ? `共找到 ${rooms.length} 个，已选择 ${selected} 个`
    : "尚未扫描";
}

function renderRooms() {
  if (!rooms.length) {
    elements.roomList.className = "room-list empty";
    elements.roomList.textContent = "没有发现直播间。请确认位于抖音搜索的“直播”分类，并让页面完成加载。";
    updateSelectionSummary();
    return;
  }

  elements.roomList.className = "room-list";
  elements.roomList.innerHTML = rooms.map((room) => `
    <label class="room-item">
      <input class="room-select" type="checkbox" data-url="${escapeHtml(room.url)}" checked>
      <span>
        <span class="room-name">${escapeHtml(room.name)}</span>
        <span class="room-url">${escapeHtml(room.url)}</span>
      </span>
    </label>
  `).join("");
  document.querySelectorAll(".room-select").forEach((input) => input.addEventListener("change", updateSelectionSummary));
  updateSelectionSummary();
}

function phaseLabel(phase) {
  return ({
    navigating: "打开中",
    waiting: "等待加载",
    capturing: "截图中",
    completed: "已完成",
    cancelled: "已停止"
  })[phase] || "待开始";
}

function renderJob(job) {
  if (!job) return;
  const running = ["navigating", "waiting", "capturing"].includes(job.phase);
  const total = job.rooms?.length || 0;
  const finished = (job.completed?.length || 0) + (job.failed?.length || 0);
  const percent = total ? Math.round((finished / total) * 100) : 0;

  elements.statusBadge.textContent = phaseLabel(job.phase);
  elements.statusBadge.className = `badge ${running ? "running" : job.phase === "completed" ? "done" : job.phase === "cancelled" ? "error" : "idle"}`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressText.textContent = job.message || "准备就绪。";
  elements.resultStats.textContent = `进度 ${finished}/${total} · 成功 ${job.completed?.length || 0} · 失败 ${job.failed?.length || 0}`;
  elements.startJob.disabled = running;
  elements.stopJob.disabled = !running;
}

async function loadPreferences() {
  const defaults = {
    brand: "",
    waitSeconds: 7,
    jitterSeconds: 3,
    maxRetries: 1,
    outputMode: "screen",
    format: "png",
    rootFolder: "直播间截图",
    returnToSearch: true
  };
  const values = await chrome.storage.local.get([...Object.keys(defaults), "settingsVersion"]);
  if (!values.settingsVersion || values.settingsVersion < 3) {
    values.format = "png";
    values.outputMode = "screen";
    await chrome.storage.local.set({ format: "png", outputMode: "screen", settingsVersion: 3 });
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (elements[key]) {
      if (elements[key].type === "checkbox") elements[key].checked = values[key] ?? fallback;
      else elements[key].value = values[key] ?? fallback;
    }
  }
}

async function savePreferences() {
  await chrome.storage.local.set({
    brand: elements.brand.value.trim(),
    waitSeconds: Number(elements.waitSeconds.value),
    jitterSeconds: Number(elements.jitterSeconds.value),
    maxRetries: Number(elements.maxRetries.value),
    outputMode: elements.outputMode.value,
    format: elements.format.value,
    rootFolder: elements.rootFolder.value.trim(),
    returnToSearch: elements.returnToSearch.checked
  });
}

elements.openSearch.addEventListener("click", async () => {
  const brand = elements.brand.value.trim();
  if (!brand) {
    elements.progressText.textContent = "请先填写品牌名称。";
    elements.brand.focus();
    return;
  }
  await savePreferences();
  const tab = await getActiveTab();
  const url = `https://www.douyin.com/jingxuan/search/${encodeURIComponent(brand)}?type=live`;
  await chrome.tabs.update(tab.id, { url });
  window.close();
});

elements.scanRooms.addEventListener("click", async () => {
  setBusy(true);
  elements.progressText.textContent = "正在向下滚动并收集直播间，请稍候……";
  try {
    const tab = await getActiveTab();
    if (!tab?.url || !/^https:\/\/(www|live)\.douyin\.com\//.test(tab.url)) {
      throw new Error("当前页面不是抖音搜索页或直播间。 ");
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "COLLECT_LIVE_ROOMS",
      options: { maxRounds: 20, delayMs: 900 }
    });
    if (!response?.ok) throw new Error(response?.error || "扫描失败。 ");
    rooms = response.rooms || [];
    renderRooms();
    elements.progressText.textContent = rooms.length
      ? `扫描完成，共找到 ${rooms.length} 个正在直播的账号。`
      : "没有找到直播间，请确认已选择搜索页的“直播”分类。";
  } catch (error) {
    elements.progressText.textContent = `扫描失败：${error.message}`;
  } finally {
    setBusy(false);
  }
});

elements.selectAll.addEventListener("click", () => {
  document.querySelectorAll(".room-select").forEach((input) => { input.checked = true; });
  updateSelectionSummary();
});

elements.selectNone.addEventListener("click", () => {
  document.querySelectorAll(".room-select").forEach((input) => { input.checked = false; });
  updateSelectionSummary();
});

elements.startJob.addEventListener("click", async () => {
  const chosen = selectedRooms();
  if (!chosen.length) {
    elements.progressText.textContent = "请先扫描并选择至少一个直播间。";
    return;
  }
  await savePreferences();
  const response = await chrome.runtime.sendMessage({
    type: "START_JOB",
    rooms: chosen,
    options: {
      brand: elements.brand.value.trim(),
      rootFolder: elements.rootFolder.value.trim(),
      waitSeconds: Number(elements.waitSeconds.value),
      jitterSeconds: Number(elements.jitterSeconds.value),
      maxRetries: Number(elements.maxRetries.value),
      outputMode: elements.outputMode.value,
      format: elements.format.value,
      quality: 100,
      returnToSearch: elements.returnToSearch.checked
    }
  });
  if (!response?.ok) {
    elements.progressText.textContent = `启动失败：${response?.error || "未知错误"}`;
    return;
  }
  renderJob(response.job);
});

elements.stopJob.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "STOP_JOB" });
  if (response?.job) renderJob(response.job);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "JOB_STATUS") renderJob(message.job);
});

(async function init() {
  await loadPreferences();
  const response = await chrome.runtime.sendMessage({ type: "GET_JOB" });
  if (response?.job) renderJob(response.job);
})();
