(function () {
  const CAPTURE_OVERLAY_ID = "__douyin_batch_capture_overlay__";
  let captureState = null;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[\\/:*?"<>|]/g, "-")
      .trim();
  }

  function normalizeLiveUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.hostname === "live.douyin.com") {
        const roomMatch = url.pathname.match(/^\/(\d+)/);
        return roomMatch ? `https://live.douyin.com/${roomMatch[1]}` : null;
      }

      if (url.hostname.endsWith("douyin.com")) {
        const liveId = url.searchParams.get("room_id") || url.searchParams.get("web_rid");
        if (liveId && /^\d+$/.test(liveId)) {
          return `https://live.douyin.com/${liveId}`;
        }
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  function findCardName(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const text = cleanText(node.innerText);
      if (!text) continue;

      const lines = String(node.innerText || "")
        .split(/\n+/)
        .map(cleanText)
        .filter(Boolean);
      const preferred = lines.find((line) =>
        line.length <= 40 &&
        !/^(直播中|正在直播|进入直播间|直播|关注|粉丝|点赞)$/.test(line) &&
        !/认证徽章|官方认证|抖音号|进入主页/.test(line) &&
        !/^\d+(\.\d+)?(万|w)?$/.test(line)
      );
      if (preferred) return preferred;
    }
    return "未命名直播间";
  }

  function collectLiveRooms() {
    const rooms = new Map();
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    for (const anchor of anchors) {
      const url = normalizeLiveUrl(anchor.href);
      if (!url) continue;

      const containerText = cleanText(anchor.closest("article, li")?.innerText || anchor.parentElement?.innerText || "");
      const isLive = /正在直播|直播中|进入直播间|live/i.test(`${containerText} ${anchor.getAttribute("aria-label") || ""}`);
      if (!isLive && location.hostname !== "live.douyin.com") continue;

      const name = findCardName(anchor);
      if (!rooms.has(url)) rooms.set(url, { name, url });
    }

    if (location.hostname === "live.douyin.com") {
      const current = normalizeLiveUrl(location.href);
      if (current) {
        const heading = document.querySelector("h1, [data-e2e*='title'], [class*='title']");
        rooms.set(current, {
          name: cleanText(heading?.textContent || document.title.replace(/[-_｜|].*$/, "")) || "当前直播间",
          url: current
        });
      }
    }

    return Array.from(rooms.values());
  }

  async function scanByScrolling(options = {}) {
    const maxRounds = Math.min(Math.max(Number(options.maxRounds) || 18, 3), 40);
    const delayMs = Math.min(Math.max(Number(options.delayMs) || 900, 500), 2500);
    const collected = new Map();
    let unchangedRounds = 0;
    let previousHeight = 0;

    window.scrollTo({ top: 0, behavior: "instant" });
    await wait(300);

    for (let round = 0; round < maxRounds; round += 1) {
      for (const room of collectLiveRooms()) collected.set(room.url, room);

      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollTo({ top: height, behavior: "smooth" });
      await wait(delayMs);

      const nextHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      unchangedRounds = nextHeight <= previousHeight + 8 ? unchangedRounds + 1 : 0;
      previousHeight = nextHeight;
      if (unchangedRounds >= 3) break;
    }

    for (const room of collectLiveRooms()) collected.set(room.url, room);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return Array.from(collected.values());
  }

  function areaOf(element) {
    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return visibleWidth * visibleHeight;
  }

  function mediaBlurPenalty(element) {
    let penalty = 0;
    let node = element;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const style = getComputedStyle(node);
      const token = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
      if (style.filter && style.filter !== "none") penalty += /blur\(/i.test(style.filter) ? 12 : 3;
      if (style.backdropFilter && style.backdropFilter !== "none") penalty += 5;
      if (/blur|background|backdrop|mask|placeholder|poster/i.test(token)) penalty += 4;
    }
    return penalty;
  }

  function mediaScore(element) {
    const rect = element.getBoundingClientRect();
    const displayedRatio = rect.width / Math.max(rect.height, 1);
    const sourceWidth = element instanceof HTMLVideoElement ? element.videoWidth : element.width;
    const sourceHeight = element instanceof HTMLVideoElement ? element.videoHeight : element.height;
    const sourceRatio = sourceWidth / Math.max(sourceHeight, 1);
    const sourcePixels = sourceWidth * sourceHeight;
    const portraitScore = sourceRatio > 0 && sourceRatio <= 0.9 ? 18 : displayedRatio <= 0.9 ? 12 : -6;
    const shapeMatch = sourceRatio > 0 ? Math.max(0, 5 - Math.abs(sourceRatio - displayedRatio) * 5) : 0;
    const resolutionScore = sourcePixels > 0 ? Math.min(12, Math.log2(sourcePixels / 100000 + 1) * 3) : 0;
    const typeScore = element instanceof HTMLVideoElement ? 8 : 0;
    const visibleScore = Math.min(10, areaOf(element) / Math.max(innerWidth * innerHeight, 1) * 10);
    return portraitScore + shapeMatch + resolutionScore + typeScore + visibleScore - mediaBlurPenalty(element);
  }

  function findPrimaryMedia() {
    const candidates = Array.from(document.querySelectorAll("video, canvas"))
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const hasSourceFrame = element instanceof HTMLVideoElement
          ? element.readyState >= 2 && element.videoWidth >= 240 && element.videoHeight >= 240
          : element.width >= 240 && element.height >= 240;
        return hasSourceFrame && style.display !== "none" && style.visibility !== "hidden" && rect.width >= 120 && rect.height >= 180;
      })
      .map((element) => ({ element, score: mediaScore(element) }))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  async function waitForVideoFrame(video) {
    if (!(video instanceof HTMLVideoElement) || typeof video.requestVideoFrameCallback !== "function") {
      await wait(120);
      return;
    }
    await Promise.race([
      new Promise((resolve) => video.requestVideoFrameCallback(() => resolve())),
      wait(700)
    ]);
  }

  async function captureNativeFrame(options = {}) {
    const media = findPrimaryMedia();
    if (!media) return { ok: false, error: "没有找到清晰的直播主视频。" };

    await waitForVideoFrame(media);
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.width;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.height;
    if (width < 240 || height < 240) return { ok: false, error: "直播源分辨率尚未就绪。" };

    try {
      const scale = Math.min(Math.max(Number(options.scale) || 1, 1), 3);
      const outputWidth = Math.round(width * scale);
      const outputHeight = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext("2d", { alpha: false });
      context.imageSmoothingEnabled = scale > 1;
      if (scale > 1) context.imageSmoothingQuality = "high";
      context.drawImage(media, 0, 0, outputWidth, outputHeight);

      const format = options.format === "jpeg" ? "jpeg" : "png";
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const quality = Math.min(Math.max(Number(options.quality) || 1, 0.8), 1);
      const dataUrl = canvas.toDataURL(mimeType, quality);
      if (!dataUrl || dataUrl.length < 2000) throw new Error("导出的直播帧为空。 ");
      return {
        ok: true,
        dataUrl,
        width: outputWidth,
        height: outputHeight,
        sourceWidth: width,
        sourceHeight: height,
        format,
        method: scale > 1 ? `native-frame-${scale}x` : "native-frame"
      };
    } catch (error) {
      return { ok: false, error: `直播源限制了原始帧提取：${error.message}` };
    }
  }

  async function prepareCapture() {
    if (captureState) return { ok: true, alreadyPrepared: true };

    const media = findPrimaryMedia();
    if (!media) return { ok: false, error: "没有找到可见的直播视频，请确认直播画面已加载。" };

    const overlay = document.createElement("div");
    overlay.id = CAPTURE_OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      background: "#000",
      zIndex: "2147483646",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden"
    });

    const original = {
      parent: media.parentNode,
      nextSibling: media.nextSibling,
      style: media.getAttribute("style"),
      controls: media instanceof HTMLVideoElement ? media.controls : undefined
    };

    document.documentElement.appendChild(overlay);
    overlay.appendChild(media);
    Object.assign(media.style, {
      position: "relative",
      inset: "auto",
      display: "block",
      width: "100vw",
      height: "100vh",
      maxWidth: "100vw",
      maxHeight: "100vh",
      margin: "0",
      padding: "0",
      objectFit: "contain",
      filter: "none",
      backdropFilter: "none",
      transform: "none",
      opacity: "1",
      visibility: "visible",
      zIndex: "2147483647"
    });
    if (media instanceof HTMLVideoElement) media.controls = false;

    captureState = { media, overlay, original };
    await wait(350);
    return {
      ok: true,
      viewport: { width: innerWidth, height: innerHeight },
      media: media.tagName.toLowerCase()
    };
  }

  function restoreCapture() {
    if (!captureState) return { ok: true };
    const { media, overlay, original } = captureState;

    if (original.nextSibling && original.nextSibling.parentNode === original.parent) {
      original.parent.insertBefore(media, original.nextSibling);
    } else {
      original.parent.appendChild(media);
    }

    if (original.style === null) media.removeAttribute("style");
    else media.setAttribute("style", original.style);
    if (media instanceof HTMLVideoElement && original.controls !== undefined) media.controls = original.controls;
    overlay.remove();
    captureState = null;
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true, url: location.href, title: document.title });
      return false;
    }

    if (message?.type === "COLLECT_LIVE_ROOMS") {
      scanByScrolling(message.options)
        .then((rooms) => sendResponse({ ok: true, rooms }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "PREPARE_CAPTURE") {
      prepareCapture()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "CAPTURE_NATIVE_FRAME") {
      captureNativeFrame(message.options)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "RESTORE_CAPTURE") {
      sendResponse(restoreCapture());
      return false;
    }

    return false;
  });
})();
