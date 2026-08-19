// SnapCard content script.
// Injects a "Generate card" camera button into every tweet's action bar,
// extracts the tweet's data straight from the DOM, and opens a preview modal
// (card.js builds the card, render.js turns it into a PNG).

(() => {
  "use strict";

  const processed = new WeakSet(); // articles we've already injected a button into
  const BTN_CLASS = "snapcard-btn";

  // ============================================================
  // Button injection
  // ============================================================

  const CAMERA_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 ' +
    '2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

  function createButton() {
    const btn = document.createElement("div");
    btn.className = BTN_CLASS;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Generate card");
    btn.title = "Generate card";
    Object.assign(btn.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "34.75px",
      height: "34.75px",
      borderRadius: "9999px",
      color: "rgb(113, 118, 123)",
      cursor: "pointer",
      transition: "background-color 0.2s ease, color 0.2s ease",
    });
    btn.innerHTML = CAMERA_ICON;
    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundColor = "rgba(29, 155, 240, 0.1)";
      btn.style.color = "rgb(29, 155, 240)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundColor = "transparent";
      btn.style.color = "rgb(113, 118, 123)";
    });
    // Deliberately no click listener here — X's React tree intercepts clicks
    // on nodes it doesn't own via a capture-phase listener on window/#react-root
    // that calls stopPropagation before bubbling handlers ever run. The fix
    // (borrowed from x-post-launcher) is a single capture-phase listener on
    // window itself, installed once below, which always runs first.
    return btn;
  }

  function injectButton(article) {
    if (processed.has(article)) return;
    const group = article.querySelector('[role="group"]');
    if (!group) return; // action bar not rendered yet; a later mutation will retry
    if (group.querySelector(`.${BTN_CLASS}`)) {
      processed.add(article);
      return;
    }
    group.appendChild(createButton());
    processed.add(article);
  }

  function scanForTweets(root) {
    (root || document)
      .querySelectorAll('article[data-testid="tweet"], article[role="article"]')
      .forEach(injectButton);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.matches &&
          (node.matches('article[data-testid="tweet"]') || node.matches('article[role="article"]'))
        ) {
          injectButton(node);
        }
        if (node.querySelectorAll) scanForTweets(node);
      }
    }
  });

  function startObserving() {
    scanForTweets(document);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving, { once: true });

  // Single window-level capture-phase click handler for our own buttons.
  // Only stopPropagation (never preventDefault) so we don't break anything
  // else on the page — we just make sure X's handlers never see this click.
  if (!window.__snapcardClickHandlerInstalled) {
    window.__snapcardClickHandlerInstalled = true;
    window.addEventListener(
      "click",
      (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const btn = target.closest(`.${BTN_CLASS}`);
        if (!btn) return;
        e.stopPropagation();
        const article = btn.closest("article");
        if (article) handleGenerateClick(article);
      },
      true
    );
  }

  // ============================================================
  // Data extraction
  // ============================================================

  // "5.2万" "1.2M" "25,000" "1.3亿" -> integer. Ported from x-profile-md-saver's
  // parseCount so the interaction-stat parsing behaves identically.
  function parseCount(s) {
    if (s == null) return null;
    s = String(s).replace(/[,，\s]/g, "");
    const m = s.match(/([\d.]+)([KMB万亿]?)/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    const u = m[2].toUpperCase();
    if (u === "K") n *= 1e3;
    else if (u === "M") n *= 1e6;
    else if (u === "B") n *= 1e9;
    else if (m[2] === "万") n *= 1e4;
    else if (m[2] === "亿") n *= 1e8;
    return Math.round(n);
  }

  function pickStat(label, keywords) {
    for (const kw of keywords) {
      const re = new RegExp("([\\d.,]+\\s*[KMB万亿]?)\\D{0,4}(?:" + kw + ")", "i");
      const m = label.match(re);
      if (m) {
        const v = parseCount(m[1]);
        if (v != null) return v;
      }
    }
    return null;
  }

  function extractStats(root) {
    let label = "";
    const group = root.querySelector('[role="group"][aria-label]');
    if (group) label = group.getAttribute("aria-label") || "";

    const stats = {
      replies: pickStat(label, ["replies", "reply", "条回复", "回复"]),
      reposts: pickStat(label, ["reposts", "repost", "retweets", "次转帖", "转帖", "转发"]),
      likes: pickStat(label, ["likes", "like", "次喜欢", "喜欢", "个赞", "赞"]),
      views: pickStat(label, ["views", "view", "次观看", "观看", "次查看", "查看"]),
    };

    if (stats.views == null) {
      const a = root.querySelector('a[href$="/analytics"][aria-label]');
      if (a) {
        const mm = (a.getAttribute("aria-label") || "").match(/([\d.,]+\s*[KMB万亿]?)/);
        if (mm) stats.views = parseCount(mm[1]);
      }
    }
    return stats;
  }

  // Walk a node's children, turning emoji <img alt> and inline <a> text into
  // plain text so the extracted string reads naturally (X renders emoji as
  // <img>, and newline characters in the tweet body live in text nodes).
  function textWithEmoji(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        if (child.tagName === "IMG") out += child.getAttribute("alt") || "";
        else if (child.tagName === "BR") out += "\n";
        else out += textWithEmoji(child);
      }
    });
    return out;
  }

  function toLargeAvatar(url) {
    if (!url) return url;
    return url.replace(/_(normal|bigger|mini|200x200|400x400)\.(jpg|jpeg|png|webp)/i, "_400x400.$2");
  }

  function toLargeImage(url) {
    if (!url || url.startsWith("data:")) return url; // query params are meaningless (and corrupting) on data: URIs
    try {
      const u = new URL(url, location.href);
      u.searchParams.set("name", "large");
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function extractAvatar(root) {
    const img = root.querySelector('[data-testid^="Tweet-User-Avatar"] img, img[src*="profile_images"]');
    if (!img) return null;
    return toLargeAvatar(img.getAttribute("src") || img.src);
  }

  // Find the leaf element whose text starts with "@" — that's the handle.
  function findHandleNode(node) {
    if (!node || node.nodeType !== 1) return null;
    const text = (node.textContent || "").trim();
    if (text.startsWith("@") && !node.querySelector("span, a")) return node;
    for (const child of node.children) {
      const found = findHandleNode(child);
      if (found) return found;
    }
    return null;
  }

  function extractNameAndHandle(root) {
    const container = root.querySelector('[data-testid="User-Name"]');
    if (!container) return { displayName: "", handle: "", verified: false };

    const verified = !!container.querySelector("svg[aria-label]");
    const handleNode = findHandleNode(container);
    const handle = handleNode ? (handleNode.textContent || "").trim() : "";

    let displayName = "";
    for (const child of container.children) {
      if (handleNode && child.contains(handleNode)) continue;
      const text = textWithEmoji(child).trim();
      if (text) {
        displayName = text;
        break;
      }
    }
    if (!displayName) {
      displayName = textWithEmoji(container).replace(handle, "").trim();
    }
    return { displayName, handle, verified };
  }

  function extractText(root) {
    const textEl = root.querySelector('[data-testid="tweetText"]');
    if (!textEl) return "";
    return textWithEmoji(textEl).trim();
  }

  function extractImages(root) {
    return Array.from(root.querySelectorAll('[data-testid="tweetPhoto"] img[src]')).map((img) =>
      toLargeImage(img.getAttribute("src"))
    );
  }

  function extractVideo(root) {
    const videoLike = root.querySelector('video, [data-testid="videoPlayer"]');
    if (!videoLike) return { hasVideo: false, poster: null };
    const posterEl = root.querySelector("video[poster]");
    return { hasVideo: true, poster: posterEl ? posterEl.getAttribute("poster") : null };
  }

  function extractTweetData(article) {
    // Strip nested (quote-tweet) <article> elements so avatar/name/text/media
    // extraction never accidentally reaches into the quoted tweet.
    const root = article.cloneNode(true);
    root.querySelectorAll("article").forEach((nested) => nested.remove());

    const { displayName, handle, verified } = extractNameAndHandle(root);
    const text = extractText(root);
    let images = extractImages(root).slice(0, 4);
    const video = extractVideo(root);
    if (video.hasVideo && video.poster && !images.length) images = [video.poster];

    const timeEl = root.querySelector("time[datetime]");
    const datetime = timeEl ? timeEl.getAttribute("datetime") : null;
    const truncated = !!root.querySelector('[data-testid="tweet-text-show-more-link"]');

    return {
      avatar: extractAvatar(root),
      displayName,
      handle,
      verified,
      text,
      images,
      hasVideo: video.hasVideo,
      stats: extractStats(root),
      datetime,
      truncated,
    };
  }

  // ============================================================
  // Settings
  // ============================================================

  function getWatermarkSetting() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ watermark: true }, (res) => resolve(!!res.watermark));
      } catch (_) {
        resolve(true);
      }
    });
  }

  const VALID_STYLES = ["white", "dark", "wallpaper"];

  // Last-picked card style, remembered across sessions.
  function getSavedStyle() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ theme: "white" }, (res) =>
          resolve(VALID_STYLES.includes(res.theme) ? res.theme : "white")
        );
      } catch (_) {
        resolve("white");
      }
    });
  }

  function saveStyle(style) {
    try {
      chrome.storage.sync.set({ theme: style });
    } catch (_) {
      // storage unavailable — not fatal, just won't be remembered next time
    }
  }

  // User-uploaded wallpaper background (data URL), if any.
  function getCustomBackground() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ customBg: null }, (res) => resolve(res.customBg || null));
      } catch (_) {
        resolve(null);
      }
    });
  }

  function setCustomBackground(dataUrl) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ customBg: dataUrl }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function clearCustomBackground() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove("customBg", () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  const DEFAULT_WALLPAPER_PATH = "assets/bg-sequoia.webp";
  function defaultWallpaperUrl() {
    try {
      return chrome.runtime.getURL(DEFAULT_WALLPAPER_PATH);
    } catch (_) {
      return "";
    }
  }

  // Downscale an uploaded image file to a data URL, longest side capped at
  // 2400px, re-encoded as JPEG q0.85 — keeps chrome.storage.local usage sane
  // for arbitrary user photos.
  function resizeImageFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const MAX_SIDE = 2400;
          let { width, height } = img;
          if (width > MAX_SIDE || height > MAX_SIDE) {
            if (width >= height) {
              height = Math.round(height * (MAX_SIDE / width));
              width = MAX_SIDE;
            } else {
              width = Math.round(width * (MAX_SIDE / height));
              height = MAX_SIDE;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = () => reject(new Error("failed to decode image"));
        img.src = reader.result;
      };
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(file);
    });
  }

  // ============================================================
  // Preview modal
  // ============================================================

  const CHINESE_RE = /[一-鿿]/g;

  function isMostlyNonChinese(text) {
    const stripped = (text || "").replace(/\s/g, "");
    if (!stripped.length) return false;
    const zh = (stripped.match(CHINESE_RE) || []).length;
    return zh / stripped.length < 0.1;
  }

  function buildFilename(handle) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
      now.getHours()
    )}${pad(now.getMinutes())}`;
    const cleanHandle = (handle || "snapcard").replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "") || "snapcard";
    return `${cleanHandle}_${stamp}.png`;
  }

  function closeModal(host) {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    document.removeEventListener("keydown", host.__snapcardEsc, true);
  }

  async function handleGenerateClick(article) {
    const data = extractTweetData(article);
    const [watermark, style, customBg] = await Promise.all([
      getWatermarkSetting(),
      getSavedStyle(),
      getCustomBackground(),
    ]);
    openPreviewModal(data, { watermark, style, customBg });
  }

  function openPreviewModal(data, options) {
    const host = document.createElement("div");
    host.id = "snapcard-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0, 0, 0, 0.6)",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: '-apple-system, "Segoe UI", sans-serif',
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background: "#ffffff",
      borderRadius: "16px",
      maxWidth: "680px",
      width: "92vw",
      maxHeight: "90vh",
      overflow: "auto",
      padding: "20px",
      boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
      boxSizing: "border-box",
    });

    if (data.truncated) {
      const notice = document.createElement("div");
      Object.assign(notice.style, {
        background: "#fff8e1",
        color: "#3d3300",
        padding: "10px 14px",
        borderRadius: "10px",
        marginBottom: "14px",
        fontSize: "13px",
        lineHeight: "1.5",
      });
      notice.innerHTML =
        "This post is truncated — open the full post first for a complete card.<br>" +
        "这条推文被折叠了，建议先点开推文全文再生成，当前只包含可见部分。";
      panel.appendChild(notice);
    }

    const previewWrap = document.createElement("div");
    Object.assign(previewWrap.style, { display: "flex", justifyContent: "center", marginBottom: "16px" });
    panel.appendChild(previewWrap);

    const state = {
      translatedText: null,
      style: VALID_STYLES.includes(options.style) ? options.style : "white",
      customBg: options.customBg || null,
      exportEl: null, // the node render.js should actually export (card, or card+wallpaper frame)
    };

    function rebuildCard() {
      previewWrap.innerHTML = "";
      const cardData = Object.assign({}, data, { translatedText: state.translatedText });
      if (state.style === "wallpaper") {
        // Wallpaper is always the white card, framed on a background image.
        const card = window.SnapCard.buildCard(cardData, { watermark: options.watermark, theme: "white" });
        previewWrap.appendChild(card); // mount first — buildWallpaperFrame needs a laid-out node to measure
        const bgUrl = state.customBg || defaultWallpaperUrl();
        const frame = window.SnapCard.buildWallpaperFrame(card, bgUrl);
        previewWrap.innerHTML = "";
        previewWrap.appendChild(frame);
        state.exportEl = frame;
      } else {
        const card = window.SnapCard.buildCard(cardData, { watermark: options.watermark, theme: state.style });
        previewWrap.appendChild(card);
        state.exportEl = card;
      }
    }
    rebuildCard();

    // ----- style selector -----
    const STYLE_LABELS = { white: "White", dark: "Dark", wallpaper: "Wallpaper" };
    const styleRow = document.createElement("div");
    Object.assign(styleRow.style, { display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" });

    const styleBtnRow = document.createElement("div");
    Object.assign(styleBtnRow.style, { display: "flex", gap: "6px" });

    const styleButtons = {};
    function paintStyleButtons() {
      VALID_STYLES.forEach((key) => {
        const active = state.style === key;
        Object.assign(styleButtons[key].style, {
          background: active ? "#1d9bf0" : "#eff3f4",
          color: active ? "#ffffff" : "#0f1419",
        });
      });
    }

    const bgControls = document.createElement("div");
    Object.assign(bgControls.style, { display: "flex", alignItems: "center", gap: "10px" });
    function updateBgControlsVisibility() {
      bgControls.style.display = state.style === "wallpaper" ? "flex" : "none";
    }

    VALID_STYLES.forEach((key) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = STYLE_LABELS[key];
      Object.assign(btn.style, {
        border: "none",
        borderRadius: "9999px",
        padding: "6px 14px",
        fontSize: "12px",
        fontWeight: "600",
        cursor: "pointer",
      });
      btn.addEventListener("click", () => {
        if (state.style === key) return;
        state.style = key;
        saveStyle(key);
        paintStyleButtons();
        updateBgControlsVisibility();
        rebuildCard();
      });
      styleButtons[key] = btn;
      styleBtnRow.appendChild(btn);
    });
    paintStyleButtons();
    styleRow.appendChild(styleBtnRow);

    // Upload / reset custom wallpaper background — only shown in Wallpaper mode.
    const uploadLabel = document.createElement("label");
    Object.assign(uploadLabel.style, { fontSize: "12px", color: "#1d9bf0", cursor: "pointer" });
    uploadLabel.textContent = "Upload background";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    uploadLabel.appendChild(fileInput);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = "Reset";
    Object.assign(resetBtn.style, {
      border: "none",
      background: "transparent",
      color: "#536471",
      fontSize: "12px",
      cursor: "pointer",
      padding: "0",
      textDecoration: "underline",
    });

    const bgStatus = document.createElement("span");
    Object.assign(bgStatus.style, { fontSize: "12px", color: "#536471" });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      bgStatus.textContent = "Processing…";
      try {
        const dataUrl = await resizeImageFileToDataUrl(file);
        await setCustomBackground(dataUrl);
        state.customBg = dataUrl;
        bgStatus.textContent = "";
      } catch (_) {
        bgStatus.textContent = "Upload failed";
      }
      rebuildCard();
    });

    resetBtn.addEventListener("click", async () => {
      await clearCustomBackground();
      state.customBg = null;
      bgStatus.textContent = "";
      rebuildCard();
    });

    bgControls.appendChild(uploadLabel);
    bgControls.appendChild(resetBtn);
    bgControls.appendChild(bgStatus);
    updateBgControlsVisibility();
    styleRow.appendChild(bgControls);

    panel.appendChild(styleRow);

    // ----- controls row -----
    const controls = document.createElement("div");
    Object.assign(controls.style, {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "10px",
    });

    const leftControls = document.createElement("div");
    Object.assign(leftControls.style, { display: "flex", alignItems: "center", gap: "8px" });

    const statusText = document.createElement("span");
    Object.assign(statusText.style, { fontSize: "12px", color: "#536471" });

    if (isMostlyNonChinese(data.text)) {
      const label = document.createElement("label");
      Object.assign(label.style, { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#0f1419", cursor: "pointer" });
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const labelText = document.createElement("span");
      labelText.textContent = "Translate";
      label.appendChild(checkbox);
      label.appendChild(labelText);
      leftControls.appendChild(label);
      leftControls.appendChild(statusText);

      checkbox.addEventListener("change", async () => {
        if (checkbox.checked) {
          statusText.textContent = "Translating…";
          try {
            const res = await chrome.runtime.sendMessage({ type: "translate", text: data.text });
            if (res && res.ok) {
              state.translatedText = res.text;
              statusText.textContent = "";
            } else {
              statusText.textContent = "翻译服务连不上（国内需代理）";
              checkbox.checked = false;
            }
          } catch (_) {
            statusText.textContent = "翻译服务连不上（国内需代理）";
            checkbox.checked = false;
          }
        } else {
          state.translatedText = null;
          statusText.textContent = "";
        }
        rebuildCard();
      });
    }

    const rightControls = document.createElement("div");
    Object.assign(rightControls.style, { display: "flex", alignItems: "center", gap: "8px" });

    function makeButton(text, primary) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      Object.assign(btn.style, {
        border: primary ? "none" : "1px solid #cfd9de",
        background: primary ? "#1d9bf0" : "#ffffff",
        color: primary ? "#ffffff" : "#0f1419",
        borderRadius: "9999px",
        padding: "8px 16px",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
      });
      return btn;
    }

    const downloadBtn = makeButton("Download PNG", true);
    downloadBtn.addEventListener("click", async () => {
      const originalLabel = downloadBtn.textContent;
      downloadBtn.textContent = "Rendering…";
      downloadBtn.disabled = true;
      try {
        const { dataUrl } = await window.SnapCard.renderCardToPng(state.exportEl, 2);
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = buildFilename(data.handle);
        a.click();
      } catch (e) {
        downloadBtn.textContent = "Render failed";
        setTimeout(() => (downloadBtn.textContent = originalLabel), 1500);
        downloadBtn.disabled = false;
        return;
      }
      downloadBtn.textContent = originalLabel;
      downloadBtn.disabled = false;
    });

    const copyBtn = makeButton("Copy image", false);
    copyBtn.addEventListener("click", async () => {
      const originalLabel = copyBtn.textContent;
      copyBtn.disabled = true;
      try {
        const { blob } = await window.SnapCard.renderCardToPng(state.exportEl, 2);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copyBtn.textContent = "Copied ✓";
      } catch (e) {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => {
        copyBtn.textContent = originalLabel;
        copyBtn.disabled = false;
      }, 1500);
    });

    const closeBtn = makeButton("Close", false);
    closeBtn.addEventListener("click", () => closeModal(host));

    rightControls.appendChild(downloadBtn);
    rightControls.appendChild(copyBtn);
    rightControls.appendChild(closeBtn);

    controls.appendChild(leftControls);
    controls.appendChild(rightControls);
    panel.appendChild(controls);

    overlay.appendChild(panel);
    shadow.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(host);
    });

    const escHandler = (e) => {
      if (e.key === "Escape") closeModal(host);
    };
    host.__snapcardEsc = escHandler;
    document.addEventListener("keydown", escHandler, true);
  }
})();
