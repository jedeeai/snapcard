// SnapCard content script.
// Injects a "Generate card" camera button into every tweet's action bar,
// extracts the tweet's data straight from the DOM, and opens a preview modal
// (card.js builds the card, render.js turns it into a PNG).

(() => {
  "use strict";

  const processed = new WeakSet(); // articles we've already injected a button into
  const BTN_CLASS = "snapcard-btn";

  // ============================================================
  // i18n
  // ============================================================

  // English fallback text for every message key used in this file — mirrors
  // _locales/en/messages.json key-for-key. chrome.i18n.getMessage() already
  // falls back to the manifest's default_locale ("en") on its own inside a
  // real extension, so this table is really just a defensive net for the
  // rare case the API is unavailable or a key is somehow missing; keep it in
  // sync with _locales/en/messages.json when adding/renaming keys.
  const I18N_FALLBACK = {
    generateCardButton: "Generate card",
    cardGeneratingText: "Generating card, this can take a few seconds…",
    truncatedNotice:
      "This tweet is truncated — open the full tweet first so the card includes everything, not just what's currently visible.",
    styleWhite: "White",
    styleDark: "Dark",
    styleWallpaper: "Wallpaper",
    wallpaperSuffix: "Wallpaper",
    uploadBackgroundTitle: "Upload background",
    processingText: "Processing…",
    customBgLimitText: "Up to %s custom backgrounds — delete one before adding another",
    uploadFailedText: "Upload failed",
    deleteBgTitle: "Delete this background",
    customBgLabel: "Custom background %s",
    moreWallpapers: "More wallpapers ▸",
    collapseWallpapers: "Collapse ◂",
    hideStatsLabel: "Hide stats",
    hideTimeLabel: "Hide date",
    stackImagesLabel: "Stack images",
    cardColorLabel: "Card",
    opacityLabel: "Opacity",
    translateLabel: "Translate",
    translatingText: "Translating…",
    translateFailedText: "Couldn't reach the translation service",
    copyImageButton: "Copy image",
    copiedText: "Copied ✓",
    copyFailedText: "Copy failed",
    downloadPngButton: "Download PNG",
    downloadGeneratingText: "Generating…",
    renderFailedText: "Render failed",
    closeButton: "Close",
    scrollHintText: "Copy button is below ↓",
    langToggleTitle: "Switch UI language",
  };

  // Sequentially substitutes %s tokens in a fallback template — mirrors (in
  // spirit, not byte-for-byte) how chrome.i18n.getMessage() fills in a
  // message's $PLACEHOLDER$ tokens from a substitutions array.
  function applyFallbackSubstitutions(template, substitutions) {
    if (substitutions == null) return template;
    const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
    let i = 0;
    return template.replace(/%s/g, () => (i < subs.length ? String(subs[i++]) : "%s"));
  }

  // Every user-visible string in this file goes through t(key, substitutions)
  // rather than being hardcoded — chrome.i18n.getMessage() resolves it
  // against the browser's UI language (falling back to _locales/en, the
  // manifest's default_locale, when a translation is missing); if the API
  // itself is unavailable for some reason, I18N_FALLBACK above is used
  // instead so the UI never renders a raw message key.
  // ---- manual UI language override (the "中/EN" toggle in the modal) ----
  // storage.sync key `uiLang`: "auto" (default — follow the browser via
  // chrome.i18n, exactly the old behavior), or an explicit "zh"/"en" chosen
  // with the toggle button in the modal's top-right corner. An explicit
  // choice can't be served by chrome.i18n (it only ever speaks the browser's
  // own language), so the real packaged _locales/*/messages.json is fetched
  // once through background.js and t() resolves against that table instead;
  // every "which language is the UI in" decision (translate direction, date
  // format, the toggle's own label) follows the override too.
  let uiLangOverride = "auto";
  let overrideMessages = null; // parsed messages.json table for the explicit language, or null
  const overrideMessagesCache = {};

  function getUiLangSetting() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ uiLang: "auto" }, (res) =>
          resolve(res.uiLang === "zh" || res.uiLang === "en" ? res.uiLang : "auto")
        );
      } catch (_) {
        resolve("auto");
      }
    });
  }

  function saveUiLang(lang) {
    try {
      chrome.storage.sync.set({ uiLang: lang });
    } catch (_) {
      // not fatal — just won't be remembered next time
    }
  }

  // Activates a language choice. On any failure the override table stays
  // null and t() falls back to chrome.i18n — worst case the UI follows the
  // browser language; it never renders raw message keys.
  async function applyUiLang(lang) {
    uiLangOverride = lang;
    if (lang !== "zh" && lang !== "en") {
      overrideMessages = null;
      return;
    }
    if (!overrideMessagesCache[lang]) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "getMessages", lang });
        if (res && res.ok && res.messages) overrideMessagesCache[lang] = res.messages;
      } catch (_) {
        // background unreachable — keep the fallback chain
      }
    }
    overrideMessages = overrideMessagesCache[lang] || null;
  }

  // chrome.i18n.getMessage()'s $PLACEHOLDER$ substitution, re-implemented
  // for raw messages.json entries (placeholder names are case-insensitive;
  // each placeholder's `content` is a "$1"-style index into substitutions).
  function resolveRawMessage(entry, substitutions) {
    const subs = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    const placeholders = entry.placeholders || {};
    return (entry.message || "").replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name) => {
      const ph = placeholders[name.toLowerCase()] || placeholders[name];
      if (!ph) return whole;
      const m = String(ph.content || "").match(/^\$(\d+)$/);
      if (!m) return ph.content || "";
      const idx = parseInt(m[1], 10) - 1;
      return subs[idx] != null ? String(subs[idx]) : "";
    });
  }

  function t(key, substitutions) {
    if (overrideMessages && overrideMessages[key]) {
      return resolveRawMessage(overrideMessages[key], substitutions);
    }
    try {
      const msg = chrome.i18n.getMessage(key, substitutions);
      if (msg) return msg;
    } catch (_) {
      // chrome.i18n unavailable — fall through to the English fallback
    }
    return applyFallbackSubstitutions(I18N_FALLBACK[key] || key, substitutions);
  }

  function uiLanguageIsChinese() {
    if (uiLangOverride === "zh") return true;
    if (uiLangOverride === "en") return false;
    try {
      return (chrome.i18n.getUILanguage() || "").toLowerCase().indexOf("zh") === 0;
    } catch (_) {
      return false;
    }
  }

  // The locale card.js should format the card's date in — the explicit
  // override when one is active, the browser's UI language otherwise.
  function effectiveLocale() {
    if (uiLangOverride === "zh") return "zh-CN";
    if (uiLangOverride === "en") return "en";
    try {
      return chrome.i18n.getUILanguage() || "en";
    } catch (_) {
      return "en";
    }
  }

  // Which language the "翻译/Translate" button translates *into*: a mostly-
  // Chinese tweet goes to English; anything else goes to Chinese under a
  // Chinese UI and to English otherwise. The toggle itself is always shown
  // (2026-08-20 user decision — a Chinese-UI user reading a Chinese tweet
  // still wants "translate to English"); the same-language edge case just
  // round-trips through Google Translate, harmless.
  function translateTargetLang(text) {
    if (isPrimarilyChinese(text)) return "en";
    return uiLanguageIsChinese() ? "zh-CN" : "en";
  }

  // Load any saved explicit language at startup so even the first modal's
  // loading spinner (built before per-open settings are read) speaks it.
  getUiLangSetting().then(applyUiLang);

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
    btn.setAttribute("aria-label", t("generateCardButton"));
    btn.title = t("generateCardButton");
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
  // <img>, and real paragraph breaks in the tweet body live as literal "\n"
  // characters inside a text node's own content — never as separate
  // whitespace-only text nodes between sibling elements).
  //
  // A whitespace-only text node between two elements (e.g. "\n  " sitting
  // between a name <span> and an emoji <img>) is HTML source formatting, not
  // tweet content — X's own React output has none of it, but nothing stops
  // some other markup (or a hand-written test fixture) from having it. If we
  // included it literally, an emoji between two spans would land on its own
  // indented line. So it's folded down to a single inline space instead.
  // Other extensions inject their own elements into X's tweet DOM (e.g. a
  // "collected" badge whose logo <img alt> would otherwise be read as emoji
  // text and spliced into the display name). X's own React output only ever
  // carries generated class names ("css-…" / "r-…") or no class at all, so
  // any element wearing a class outside that scheme is foreign — not tweet
  // content — and text extraction skips it wholesale.
  function isForeignNode(el) {
    for (const cls of el.classList) {
      if (!/^(css-|r-)/.test(cls)) return true;
    }
    return false;
  }

  function textWithEmoji(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const raw = child.nodeValue;
        out += /^\s*$/.test(raw) ? (raw.length ? " " : "") : raw;
      } else if (child.nodeType === 1) {
        if (isForeignNode(child)) return;
        if (child.tagName === "IMG") out += child.getAttribute("alt") || "";
        else if (child.tagName === "BR") out += "\n";
        else out += textWithEmoji(child);
      }
    });
    return out;
  }

  // Collapse the inline spaces/tabs introduced above (and any the real markup
  // had) down to single spaces, and trim spaces hugging a real newline —
  // without touching the newlines themselves, so genuine multi-paragraph
  // tweet text is left intact.
  function normalizeExtractedText(s) {
    return s
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
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
    if (!node || node.nodeType !== 1 || isForeignNode(node)) return null;
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
      if (isForeignNode(child)) continue;
      const text = normalizeExtractedText(textWithEmoji(child));
      if (text) {
        displayName = text;
        break;
      }
    }
    if (!displayName) {
      displayName = normalizeExtractedText(textWithEmoji(container).replace(handle, ""));
    }
    return { displayName, handle, verified };
  }

  function extractText(root) {
    const textEl = root.querySelector('[data-testid="tweetText"]');
    if (!textEl) return "";
    return normalizeExtractedText(textWithEmoji(textEl));
  }

  // Reads each photo's *displayed* aspect ratio straight off the live
  // timeline (getBoundingClientRect on the tweetPhoto container, not the
  // <img>'s natural size) so the card's grid can mirror however X itself is
  // actually cropping/showing it — a tall 9:16 screenshot shown near-full-
  // height in a 2-up row on x.com should look the same way in the card, not
  // get force-cropped by a generic fixed ratio.
  //
  // Must run on the *live* `article` (not a detached clone) — getBoundingClientRect
  // on an unattached node returns an all-zero rect. Nested quote-tweet photos
  // are excluded by checking each <img>'s closest <article> is this one, not
  // an inner one.
  function extractImages(article) {
    const results = [];
    article.querySelectorAll('[data-testid="tweetPhoto"] img[src]').forEach((img) => {
      if (img.closest("article") !== article) return; // inside a nested quote tweet — skip
      const container = img.closest('[data-testid="tweetPhoto"]') || img;
      const rect = container.getBoundingClientRect();
      const aspectRatio = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : null;
      results.push({ url: toLargeImage(img.getAttribute("src")), aspectRatio });
    });
    return results;
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
    // extractImages needs the *live* article (not the detached clone) for
    // getBoundingClientRect() to return real numbers — see its own comment.
    let images = extractImages(article).slice(0, 4);
    const video = extractVideo(root);
    if (video.hasVideo && video.poster && !images.length) images = [{ url: video.poster, aspectRatio: null }];

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
        chrome.storage.sync.get({ watermark: false }, (res) => resolve(!!res.watermark));
      } catch (_) {
        resolve(false);
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

  const MAX_CUSTOM_BACKGROUNDS = 6;

  // User-uploaded wallpaper backgrounds (data URLs), up to MAX_CUSTOM_BACKGROUNDS.
  // One-time migration: the old single-image key `customBg` (pre-multi-image)
  // becomes the first element of the new `customBgs` array, and the old key
  // is removed so this only ever runs once.
  function getCustomBackgrounds() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ customBgs: null, customBg: null }, (res) => {
          if (Array.isArray(res.customBgs)) {
            resolve(res.customBgs);
            return;
          }
          if (res.customBg) {
            const migrated = [res.customBg];
            chrome.storage.local.set({ customBgs: migrated }, () => {
              chrome.storage.local.remove("customBg", () => resolve(migrated));
            });
            return;
          }
          resolve([]);
        });
      } catch (_) {
        resolve([]);
      }
    });
  }

  function setCustomBackgrounds(list) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ customBgs: list }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  // Whether the interaction-stats row (and its divider) is hidden.
  function getHideStatsSetting() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ hideStats: false }, (res) => resolve(!!res.hideStats));
      } catch (_) {
        resolve(false);
      }
    });
  }

  function saveHideStats(value) {
    try {
      chrome.storage.sync.set({ hideStats: !!value });
    } catch (_) {
      // not fatal — just won't be remembered next time
    }
  }

  // Whether the date (next to the name/verified badge) is hidden. Same
  // storage/memory pattern as hideStats.
  function getHideTimeSetting() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ hideTime: false }, (res) => resolve(!!res.hideTime));
      } catch (_) {
        resolve(false);
      }
    });
  }

  function saveHideTime(value) {
    try {
      chrome.storage.sync.set({ hideTime: !!value });
    } catch (_) {
      // not fatal — just won't be remembered next time
    }
  }

  // Whether 3+ images render as a full-width vertical stack instead of the
  // X-mirroring grid. Same storage/memory pattern as hideStats/hideTime.
  function getStackImagesSetting() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ stackImages: false }, (res) => resolve(!!res.stackImages));
      } catch (_) {
        resolve(false);
      }
    });
  }

  function saveStackImages(value) {
    try {
      chrome.storage.sync.set({ stackImages: !!value });
    } catch (_) {
      // not fatal — just won't be remembered next time
    }
  }

  // Wallpaper-mode card appearance: which palette the card itself uses
  // ("white"/"dark" — independent of the outer style selector) and how
  // opaque its background is (integer percent, 30–100; below 30 the text
  // gets hard to read against busy wallpapers). Both remembered.
  const VALID_CARD_THEMES = ["white", "dark"];

  function clampCardOpacity(v) {
    const n = Math.round(Number(v));
    if (isNaN(n)) return 100;
    return Math.min(100, Math.max(30, n));
  }

  function getWallpaperCardSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ wallpaperCardTheme: "white", wallpaperCardOpacity: 100 }, (res) =>
          resolve({
            theme: VALID_CARD_THEMES.includes(res.wallpaperCardTheme) ? res.wallpaperCardTheme : "white",
            opacity: clampCardOpacity(res.wallpaperCardOpacity),
          })
        );
      } catch (_) {
        resolve({ theme: "white", opacity: 100 });
      }
    });
  }

  function saveWallpaperCardSettings(theme, opacity) {
    try {
      chrome.storage.sync.set({ wallpaperCardTheme: theme, wallpaperCardOpacity: opacity });
    } catch (_) {
      // not fatal — just won't be remembered next time
    }
  }

  // ---------- wallpaper background picker ----------
  // 7 built-in original gradient photos (bundled in assets/, self-made —
  // replaced the earlier Apple macOS wallpapers so the extension ships no
  // Apple-copyrighted assets, see the CLAUDE.md fault log for why), or
  // "custom" (user-uploaded photo, stored separately in chrome.storage.local
  // as customBg). `name` is a proper noun (photo name) and stays
  // untranslated in both locales; the "壁纸/Wallpaper" suffix shown to the
  // user is appended at render time via t("wallpaperSuffix") — see
  // renderBgThumbnails below — so it follows the UI language instead of
  // being baked in here.
  const BUILTIN_BACKGROUNDS = [
    { id: "aurora", name: "Aurora", file: "assets/bg-aurora.jpg" },
    { id: "sunset", name: "Sunset", file: "assets/bg-sunset.jpg" },
    { id: "rose", name: "Rose", file: "assets/bg-rose.jpg" },
    { id: "ocean", name: "Ocean", file: "assets/bg-ocean.jpg" },
    { id: "violet", name: "Violet", file: "assets/bg-violet.jpg" },
    { id: "golden", name: "Golden", file: "assets/bg-golden.jpg" },
    { id: "graphite", name: "Graphite", file: "assets/bg-graphite.jpg" },
  ];

  function builtinBackgroundUrl(entry) {
    try {
      return chrome.runtime.getURL(entry.file);
    } catch (_) {
      return "";
    }
  }

  // Kept as a plain function (not folded into resolveBackgroundUrl) since
  // buildWallpaperFrame's fallback and the thumbnail row both want "the
  // default photo" specifically, independent of whatever bgId is selected.
  function defaultWallpaperUrl() {
    return builtinBackgroundUrl(BUILTIN_BACKGROUNDS[0]);
  }

  function getSavedBackgroundId() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ wallpaperBg: "aurora" }, (res) => resolve(res.wallpaperBg || "aurora"));
      } catch (_) {
        resolve("aurora");
      }
    });
  }

  function saveBackgroundId(id) {
    try {
      chrome.storage.sync.set({ wallpaperBg: id });
    } catch (_) {
      // not fatal — just won't be remembered next time
    }
  }

  // A custom upload's id is "custom:<index into customBgs>" — indices are
  // never stored per-image, they're just each image's current array
  // position, recomputed on every render. That means a deletion earlier in
  // the array naturally "renumbers" everything after it for free; the only
  // thing that can go stale is a *previously selected* id pointing past the
  // end of a shrunk array, which this treats as "fall back to Aurora".
  function resolveBackgroundUrl(bgId, customBgs) {
    if (typeof bgId === "string" && bgId.indexOf("custom:") === 0) {
      const idx = parseInt(bgId.slice(7), 10);
      if (Array.isArray(customBgs) && idx >= 0 && idx < customBgs.length) return customBgs[idx];
      return defaultWallpaperUrl(); // stale/out-of-range index — the image was deleted
    }
    const entry = BUILTIN_BACKGROUNDS.find((b) => b.id === bgId);
    if (entry) return builtinBackgroundUrl(entry);
    return defaultWallpaperUrl(); // unrecognized id (including any retired Apple-wallpaper id like "sequoia") — safe fallback to Aurora
  }

  // Validates a persisted bgId against the actual customBgs array length —
  // used once when a modal opens, so a stale "custom:N" from a since-deleted
  // image falls back to Aurora instead of silently resolving to whatever
  // image now happens to occupy that slot (or nothing, if the array shrank).
  // Also the retired-Apple-wallpaper compatibility path: a user who had one
  // of the old lineup selected (sequoia/sparrow/silver/rose-gold/
  // albany-gold/space-gray/gradient-dark, from before the 2026-08-20 asset
  // swap — see CLAUDE.md fault log) has that id still sitting in
  // chrome.storage.sync, and it no longer matches any BUILTIN_BACKGROUNDS
  // entry — falls back to Aurora here rather than leaving state.bgId pointed
  // at a dead id (which would otherwise resolve to the right background via
  // resolveBackgroundUrl's own fallback, but leave no thumbnail showing as
  // selected — the thumbnail row's "selected" check is `state.bgId ===
  // item.id`, a strict match against the *current* BUILTIN_BACKGROUNDS ids).
  function sanitizeBgId(bgId, customBgs) {
    if (typeof bgId === "string" && bgId.indexOf("custom:") === 0) {
      const idx = parseInt(bgId.slice(7), 10);
      if (!(Array.isArray(customBgs) && idx >= 0 && idx < customBgs.length)) return "aurora";
      return bgId;
    }
    if (BUILTIN_BACKGROUNDS.some((b) => b.id === bgId)) return bgId;
    return "aurora"; // unrecognized id (missing, or a retired Apple-wallpaper id) — fall back to Aurora
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

  // "Primary language" heuristic: a body is treated as (primarily) Chinese
  // once at least 10% of its non-whitespace characters are CJK — same 10%
  // cutoff the old isMostlyNonChinese() used, just phrased as the positive
  // case so it can be compared against the UI's own language below.
  function isPrimarilyChinese(text) {
    const stripped = (text || "").replace(/\s/g, "");
    if (!stripped.length) return false;
    const zh = (stripped.match(CHINESE_RE) || []).length;
    return zh / stripped.length >= 0.1;
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

  // Resolves once every <img> currently inside `root` has finished loading
  // and decoding — i.e. once layout that depends on natural image size is
  // final. Broken images and a hung network resolve too (per-image catch +
  // an overall timeout): measuring a slightly-wrong height beats hanging the
  // modal forever. decode() works on detached nodes (loading starts when
  // src is set, mounting is irrelevant).
  function waitForImages(root, timeoutMs) {
    const pending = Array.from(root.querySelectorAll("img")).map((img) =>
      img.decode ? img.decode().catch(() => {}) : Promise.resolve()
    );
    if (!pending.length) return Promise.resolve();
    return Promise.race([
      Promise.all(pending),
      new Promise((resolve) => setTimeout(resolve, timeoutMs || 5000)),
    ]);
  }

  function closeModal(host) {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    document.removeEventListener("keydown", host.__snapcardEsc, true);
    if (host.__snapcardResize) window.removeEventListener("resize", host.__snapcardResize);
  }

  async function handleGenerateClick(article) {
    // Open the modal shell (with a loading spinner) immediately, synchronously,
    // so the click feels instant — extracting a real tweet's DOM and building
    // the first card can take a perceptible moment on tweets with lots of
    // media, and previously that work all happened *before* the modal ever
    // appeared, which read as "did my click even register?".
    const shell = createModalShell();
    await nextPaint(); // let the spinner actually paint before the heavy synchronous work below runs
    if (!shell.host.isConnected) return; // closed before we got this far

    const data = extractTweetData(article);
    const [watermark, style, customBgs, hideStats, hideTime, savedBgId, uiLang, stackImages, wallpaperCard] = await Promise.all([
      getWatermarkSetting(),
      getSavedStyle(),
      getCustomBackgrounds(),
      getHideStatsSetting(),
      getHideTimeSetting(),
      getSavedBackgroundId(),
      getUiLangSetting(),
      getStackImagesSetting(),
      getWallpaperCardSettings(),
    ]);
    if (!shell.host.isConnected) return; // closed while settings were loading
    await applyUiLang(uiLang); // must resolve before finishModal renders any t() text
    if (!shell.host.isConnected) return; // closed while the language table was loading

    finishModal(shell, data, {
      watermark,
      style,
      customBgs,
      hideStats,
      hideTime,
      stackImages,
      wallpaperCard,
      bgId: sanitizeBgId(savedBgId, customBgs),
      article, // kept so the 中/EN toggle can rebuild this same modal from scratch
    });
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // Phase 1: the modal shell — host/shadow/overlay/panel/previewWrap, shown
  // immediately with a loading spinner in place of the (not yet built) card.
  // Close-on-overlay-click and Esc-to-close are wired up here, not in
  // finishModal, so the user can cancel out even while still loading.
  function createModalShell() {
    const host = document.createElement("div");
    host.id = "snapcard-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = "@keyframes snapcard-spin { to { transform: rotate(360deg); } }";
    shadow.appendChild(styleEl);

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

    const previewWrap = document.createElement("div");
    Object.assign(previewWrap.style, { display: "flex", justifyContent: "center", marginBottom: "16px" });

    const loadingWrap = document.createElement("div");
    Object.assign(loadingWrap.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "12px",
      padding: "80px 40px",
    });
    loadingWrap.dataset.snapcardRole = "loading-wrap";
    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
      width: "28px",
      height: "28px",
      borderRadius: "50%",
      border: "3px solid #eff3f4",
      borderTopColor: "#8b98a5", // gray only — colorblind rule: no red/green
      animation: "snapcard-spin 0.8s linear infinite",
    });
    const loadingText = document.createElement("div");
    Object.assign(loadingText.style, { fontSize: "14px", color: "#536471" });
    loadingText.textContent = t("cardGeneratingText");
    loadingWrap.appendChild(spinner);
    loadingWrap.appendChild(loadingText);
    previewWrap.appendChild(loadingWrap);

    panel.appendChild(previewWrap);
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

    return { host, shadow, overlay, panel, previewWrap };
  }

  // Phase 2: tweet data + saved settings are ready — replace the spinner with
  // the real card and build the rest of the modal (truncated notice, style
  // selector, background picker, controls, scroll hint). This is everything
  // the old single-phase modal builder used to do before the modal was ever
  // shown; now it all runs after an already-visible modal instead.
  function finishModal(shell, data, options) {
    const { host, shadow, panel, previewWrap } = shell;

    // ----- UI language toggle (its own slim header row, above the preview —
    // NOT overlaid on it: an absolutely-positioned corner button used to sit
    // on top of the card image) -----
    // The button shows the language it switches *to*: "EN" while the UI is
    // Chinese, "中" while it's English. Clicking stores the explicit choice
    // (storage.sync `uiLang`) and rebuilds the modal through the exact same
    // path as the original open, so every label re-renders in the new
    // language — no in-place retranslation of dozens of nodes.
    const headerRow = document.createElement("div");
    Object.assign(headerRow.style, { display: "flex", justifyContent: "flex-end", marginBottom: "8px" });
    const langBtn = document.createElement("button");
    langBtn.type = "button";
    langBtn.dataset.snapcardRole = "lang-toggle";
    langBtn.textContent = uiLanguageIsChinese() ? "EN" : "中";
    langBtn.title = t("langToggleTitle");
    Object.assign(langBtn.style, {
      border: "1px solid #cfd9de",
      background: "#ffffff",
      color: "#0f1419",
      borderRadius: "9999px",
      padding: "4px 10px",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
    });
    langBtn.addEventListener("click", () => {
      saveUiLang(uiLanguageIsChinese() ? "en" : "zh");
      closeModal(host);
      if (options.article) handleGenerateClick(options.article);
    });
    headerRow.appendChild(langBtn);
    panel.insertBefore(headerRow, panel.firstChild);

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
      notice.textContent = t("truncatedNotice");
      panel.insertBefore(notice, previewWrap); // previewWrap already exists from phase 1
    }

    const state = {
      translatedText: null,
      style: VALID_STYLES.includes(options.style) ? options.style : "white",
      customBgs: options.customBgs || [],
      hideStats: !!options.hideStats,
      hideTime: !!options.hideTime,
      stackImages: !!options.stackImages,
      wallpaperCardTheme: (options.wallpaperCard && options.wallpaperCard.theme) || "white",
      wallpaperCardOpacity: (options.wallpaperCard && options.wallpaperCard.opacity) || 100,
      bgId: options.bgId || "aurora",
      exportEl: null, // the node render.js should actually export (card, or card+wallpaper frame)
    };

    // Real implementation is assigned further down, once the hint element
    // exists — this placeholder just means rebuildCard() (defined next, and
    // invoked once immediately below) always has something safe to call.
    let updateScrollHint = () => {};

    // Builds the real (unscaled) card/frame that render.js will eventually
    // export, staging it in a throwaway offscreen container only when
    // Wallpaper mode needs a laid-out node to measure (buildWallpaperFrame's
    // own requirement) — this node is never mounted inside previewWrap and
    // never gets a transform/scale of its own; see renderScaledPreview below
    // for why that separation matters.
    async function buildExportEl(cardData, cardOptions) {
      const theme = state.style === "wallpaper" ? state.wallpaperCardTheme : state.style;
      const card = window.SnapCard.buildCard(cardData, Object.assign({ theme }, cardOptions));
      // Both one-time measurements downstream (the wallpaper frame's
      // getBoundingClientRect here, the preview-scale probe in
      // renderScaledPreview) need the card's layout to be *final* — and a
      // single-image tile without a captured display ratio only reaches its
      // real height once the image has loaded. Measuring before that was the
      // "long tweets get clipped in preview AND zoom" bug (see fault log).
      await waitForImages(card);
      // Natural sizes are now known — lock the media area to its final
      // layout (single image in full, 2-up equal height, stack mode) before
      // anything measures the card.
      window.SnapCard.finalizeMediaLayout(card);
      if (state.style !== "wallpaper") return card;

      // Translucent card over the wallpaper: only the card's own background
      // gains alpha — text, borders and images keep full contrast. 100% is
      // left untouched so the default renders exactly as before.
      if (state.wallpaperCardOpacity < 100) {
        const alpha = state.wallpaperCardOpacity / 100;
        card.style.backgroundColor =
          state.wallpaperCardTheme === "dark" ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
      }

      const stage = document.createElement("div");
      Object.assign(stage.style, { position: "fixed", left: "-9999px", top: "0" });
      stage.appendChild(card);
      document.body.appendChild(stage);
      const bgUrl = resolveBackgroundUrl(state.bgId, state.customBgs);
      const frame = window.SnapCard.buildWallpaperFrame(card, bgUrl); // reparents card out of stage
      document.body.removeChild(stage);
      return frame;
    }

    // Scales a *clone* of exportEl down to fit within `viewport` (never
    // touches exportEl itself — the "position:fixed got serialized into the
    // export" fault-log entry is exactly what happens if a transform/scale
    // ends up on the node render.js later clones for the real PNG). Wrapper
    // gets the post-scale pixel size explicitly (transform doesn't change
    // layout size, only paint) so surrounding flex layout doesn't reserve
    // the full unscaled footprint.
    function renderScaledPreview(exportEl, viewport) {
      const previewClone = exportEl.cloneNode(true);

      const probe = document.createElement("div");
      Object.assign(probe.style, { position: "fixed", left: "-9999px", top: "0" });
      probe.appendChild(previewClone);
      document.body.appendChild(probe);
      const rect = previewClone.getBoundingClientRect();
      const naturalWidth = rect.width;
      const naturalHeight = rect.height;
      document.body.removeChild(probe);

      const viewportRect = viewport.getBoundingClientRect();
      const scale = Math.min(viewportRect.width / naturalWidth, viewportRect.height / naturalHeight, 1);

      const scaledWrapper = document.createElement("div");
      scaledWrapper.dataset.snapcardRole = "preview-scaled-wrapper";
      Object.assign(scaledWrapper.style, {
        width: `${naturalWidth * scale}px`,
        height: `${naturalHeight * scale}px`,
        flexShrink: "0", // never let the flex viewport squeeze this off its computed size (see the wallpaper-frame fault-log entry)
        cursor: "zoom-in",
        overflow: "hidden",
      });

      Object.assign(previewClone.style, { transform: `scale(${scale})`, transformOrigin: "top left" });
      scaledWrapper.appendChild(previewClone); // moves it out of the (removed) probe
      scaledWrapper.addEventListener("click", () => openZoomOverlay(exportEl));
      viewport.appendChild(scaledWrapper);
    }

    // Full-size, scrollable, click-or-Esc-to-close overlay showing a clone of
    // the real exportEl at 1:1. Temporarily unhooks the modal's own
    // Esc-to-close (registered in createModalShell) while open: both would
    // otherwise be capture-phase listeners on `document`, and the modal's
    // — registered first — would fire first and close everything before this
    // layer's own handler got a chance to just close itself.
    function openZoomOverlay(exportEl) {
      document.removeEventListener("keydown", host.__snapcardEsc, true);

      const zoomHost = document.createElement("div");
      zoomHost.dataset.snapcardRole = "zoom-overlay";
      Object.assign(zoomHost.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.85)",
        zIndex: "2147483647",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        overflow: "auto",
        cursor: "zoom-out",
        padding: "40px",
        boxSizing: "border-box",
      });

      const zoomClone = exportEl.cloneNode(true);
      zoomClone.dataset.snapcardRole = "zoom-clone";
      zoomClone.style.cursor = "zoom-out";
      zoomClone.style.flexShrink = "0";
      zoomHost.appendChild(zoomClone);

      function close() {
        if (zoomHost.parentNode) zoomHost.parentNode.removeChild(zoomHost);
        document.removeEventListener("keydown", escHandler, true);
        document.addEventListener("keydown", host.__snapcardEsc, true); // restore the modal's own Esc-to-close
      }
      zoomHost.addEventListener("click", close); // click *anywhere* in the layer closes it
      const escHandler = (e) => {
        if (e.key === "Escape") close();
      };
      document.addEventListener("keydown", escHandler, true);

      shadow.appendChild(zoomHost);
    }

    // Monotonic rebuild counter: buildExportEl awaits image decoding, so two
    // rebuilds can overlap (rapid style clicks). Only the newest may touch
    // previewWrap — a stale one finishing late would otherwise clobber the
    // newer preview with an outdated card.
    let rebuildSeq = 0;

    async function rebuildCard() {
      const seq = ++rebuildSeq;
      const cardData = Object.assign({}, data, { translatedText: state.translatedText });
      const cardOptions = {
        watermark: options.watermark,
        hideStats: state.hideStats,
        hideTime: state.hideTime,
        stackImages: state.stackImages,
        locale: effectiveLocale(),
      };

      const exportEl = await buildExportEl(cardData, cardOptions);
      if (seq !== rebuildSeq || !host.isConnected) return; // superseded or modal closed while images loaded

      // Only now clear the previous content (the loading spinner on the
      // first call, the previous card afterwards) — while images decode the
      // user keeps seeing the old state instead of a blank flash.
      previewWrap.innerHTML = "";
      state.exportEl = exportEl;
      // exportEl is intentionally never mounted inside previewWrap (the
      // visible preview shows a *scaled clone* of it — see
      // renderScaledPreview), so it isn't reachable via a shadow DOM query at
      // all. This reference exists purely so tests/smoke.py can get at the
      // real, unscaled, about-to-be-exported node; nothing else reads it.
      host.__snapcardExportEl = state.exportEl;

      // Fixed-height viewport (~56vh, full panel content width) the scaled
      // card is centered inside — this is what "fits the whole card on one
      // screen" actually means; recomputed on every rebuild (style/background/
      // translation/hide-toggle changes) since the card's natural size can
      // change with any of those.
      const viewport = document.createElement("div");
      viewport.dataset.snapcardRole = "preview-viewport";
      Object.assign(viewport.style, {
        width: "100%",
        height: "56vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      });
      previewWrap.appendChild(viewport);
      renderScaledPreview(state.exportEl, viewport);

      // Content height may have just changed (style switch, translation
      // added/removed a block) — re-check whether the panel now overflows.
      // (Should rarely fire now that the preview always fits ~56vh, but kept
      // as a fallback for anything the fit-to-view math doesn't cover.)
      updateScrollHint();
    }
    rebuildCard();

    // ----- style selector -----
    const STYLE_LABELS = { white: t("styleWhite"), dark: t("styleDark"), wallpaper: t("styleWallpaper") };
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
    Object.assign(bgControls.style, { display: "flex", alignItems: "center", gap: "8px" });

    // ----- wallpaper card appearance row (Wallpaper mode only) -----
    // The card inside the wallpaper frame gets its own white/dark choice
    // (independent of the outer style selector — that one picks the *frame*
    // mode) plus a background-opacity slider so the wallpaper can shine
    // through a translucent card.
    const cardControls = document.createElement("div");
    cardControls.dataset.snapcardRole = "wallpaper-card-controls";
    Object.assign(cardControls.style, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });

    const cardColorText = document.createElement("span");
    Object.assign(cardColorText.style, { fontSize: "12px", color: "#536471" });
    cardColorText.textContent = t("cardColorLabel");
    cardControls.appendChild(cardColorText);

    const cardThemeButtons = {};
    function paintCardThemeButtons() {
      VALID_CARD_THEMES.forEach((key) => {
        const active = state.wallpaperCardTheme === key;
        Object.assign(cardThemeButtons[key].style, {
          background: active ? "#1d9bf0" : "#eff3f4",
          color: active ? "#ffffff" : "#0f1419",
        });
      });
    }
    VALID_CARD_THEMES.forEach((key) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.snapcardRole = `card-theme-${key}`;
      btn.textContent = key === "white" ? t("styleWhite") : t("styleDark");
      Object.assign(btn.style, {
        border: "none",
        borderRadius: "9999px",
        padding: "4px 12px",
        fontSize: "12px",
        fontWeight: "600",
        cursor: "pointer",
      });
      btn.addEventListener("click", () => {
        if (state.wallpaperCardTheme === key) return;
        state.wallpaperCardTheme = key;
        saveWallpaperCardSettings(state.wallpaperCardTheme, state.wallpaperCardOpacity);
        paintCardThemeButtons();
        rebuildCard();
      });
      cardThemeButtons[key] = btn;
      cardControls.appendChild(btn);
    });
    paintCardThemeButtons();

    const opacityText = document.createElement("span");
    Object.assign(opacityText.style, { fontSize: "12px", color: "#536471", marginLeft: "8px" });
    opacityText.textContent = t("opacityLabel");
    cardControls.appendChild(opacityText);

    const opacitySlider = document.createElement("input");
    opacitySlider.type = "range";
    opacitySlider.min = "30";
    opacitySlider.max = "100";
    opacitySlider.step = "5";
    opacitySlider.value = String(state.wallpaperCardOpacity);
    opacitySlider.dataset.snapcardRole = "card-opacity-slider";
    Object.assign(opacitySlider.style, { width: "110px", cursor: "pointer" });
    const opacityValue = document.createElement("span");
    Object.assign(opacityValue.style, { fontSize: "12px", color: "#0f1419", minWidth: "38px" });
    opacityValue.textContent = `${state.wallpaperCardOpacity}%`;
    // Live percent label while dragging; the (expensive) card rebuild only
    // fires on release ("change"), not per drag pixel.
    opacitySlider.addEventListener("input", () => {
      opacityValue.textContent = `${clampCardOpacity(opacitySlider.value)}%`;
    });
    opacitySlider.addEventListener("change", () => {
      state.wallpaperCardOpacity = clampCardOpacity(opacitySlider.value);
      saveWallpaperCardSettings(state.wallpaperCardTheme, state.wallpaperCardOpacity);
      rebuildCard();
    });
    cardControls.appendChild(opacitySlider);
    cardControls.appendChild(opacityValue);

    function updateBgControlsVisibility() {
      const display = state.style === "wallpaper" ? "flex" : "none";
      bgControls.style.display = display;
      cardControls.style.display = display;
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

    // ----- background picker (Wallpaper mode only) -----
    // Two states, never remembered across modal opens (always starts
    // collapsed): collapsed shows just the current selection + a "更多壁纸"
    // toggle; expanded reveals every built-in + custom background, the
    // upload button, and a "收起" toggle. The reveal animates via max-width
    // on a wrapper (250ms): expanding populates the wrapper's children
    // *before* growing it (so there's something to animate open), collapsing
    // shrinks it first and only clears the children once the transition
    // would have finished, so both directions animate rather than snapping.
    let bgExpanded = false;

    function buildBgThumb(item, allowDelete) {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, { position: "relative", flexShrink: "0" });

      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.title = item.label;
      const selected = state.bgId === item.id;
      Object.assign(thumb.style, {
        width: "28px",
        height: "28px",
        borderRadius: "50%",
        display: "block",
        backgroundImage: `url("${item.url}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        border: selected ? "2px solid #1d9bf0" : "2px solid transparent",
        boxShadow: selected ? "none" : "0 0 0 1px #eff3f4",
        padding: "0",
        cursor: "pointer",
      });
      thumb.addEventListener("click", () => {
        if (state.bgId === item.id) return;
        state.bgId = item.id;
        saveBackgroundId(item.id);
        renderBgThumbnails();
        rebuildCard();
      });
      wrap.appendChild(thumb);

      if (allowDelete) {
        const del = document.createElement("button");
        del.type = "button";
        del.title = t("deleteBgTitle");
        del.dataset.snapcardRole = "bg-delete";
        del.textContent = "×"; // ×
        Object.assign(del.style, {
          position: "absolute",
          top: "-4px",
          right: "-4px",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          border: "1px solid #ffffff",
          background: "#57606a", // dark gray circle — colorblind rule: no red
          color: "#ffffff",
          fontSize: "11px",
          lineHeight: "14px",
          textAlign: "center",
          padding: "0",
          cursor: "pointer",
        });
        del.addEventListener("mouseenter", () => (del.style.background = "#3d444d"));
        del.addEventListener("mouseleave", () => (del.style.background = "#57606a"));
        del.addEventListener("click", async (e) => {
          e.stopPropagation(); // don't also trigger the thumb's own click (select)
          const idx = parseInt(item.id.slice(7), 10);
          const wasSelected = state.bgId === item.id;
          const next = state.customBgs.slice();
          next.splice(idx, 1);
          state.customBgs = next;
          await setCustomBackgrounds(next);
          if (wasSelected) {
            state.bgId = "aurora";
            saveBackgroundId("aurora");
          } else if (typeof state.bgId === "string" && state.bgId.indexOf("custom:") === 0) {
            // ids are array positions, not stable per-image — deleting an
            // earlier custom image shifts every later one down by one, so a
            // still-selected later image needs its id shifted to match.
            const selIdx = parseInt(state.bgId.slice(7), 10);
            if (selIdx > idx) {
              state.bgId = `custom:${selIdx - 1}`;
              saveBackgroundId(state.bgId);
            }
          }
          renderBgThumbnails();
          rebuildCard();
        });
        wrap.appendChild(del);
      }

      return wrap;
    }

    function buildUploadButton(bgStatus) {
      const uploadBtn = document.createElement("label");
      uploadBtn.title = t("uploadBackgroundTitle");
      Object.assign(uploadBtn.style, {
        width: "28px",
        height: "28px",
        borderRadius: "50%",
        border: "2px dashed #cfd9de",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        flexShrink: "0",
        color: "#536471",
        fontSize: "16px",
        lineHeight: "1",
      });
      uploadBtn.textContent = "+";
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.style.display = "none";
      uploadBtn.appendChild(fileInput);

      fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (state.customBgs.length >= MAX_CUSTOM_BACKGROUNDS) {
          bgStatus.textContent = t("customBgLimitText", [String(MAX_CUSTOM_BACKGROUNDS)]);
          return;
        }
        bgStatus.textContent = t("processingText");
        try {
          const dataUrl = await resizeImageFileToDataUrl(file);
          const next = state.customBgs.concat([dataUrl]);
          await setCustomBackgrounds(next);
          state.customBgs = next;
          state.bgId = `custom:${next.length - 1}`;
          saveBackgroundId(state.bgId);
          bgStatus.textContent = "";
        } catch (_) {
          bgStatus.textContent = t("uploadFailedText");
        }
        renderBgThumbnails();
        rebuildCard();
      });

      return uploadBtn;
    }

    function renderBgThumbnails() {
      bgControls.innerHTML = "";

      const wallpaperSuffix = t("wallpaperSuffix");
      const builtinItems = BUILTIN_BACKGROUNDS.map((b) => ({
        id: b.id,
        label: `${b.name} ${wallpaperSuffix}`,
        url: builtinBackgroundUrl(b),
      }));
      const customItems = state.customBgs.map((url, i) => ({
        id: `custom:${i}`,
        label: t("customBgLabel", [String(i + 1)]),
        url,
      }));
      const allItems = builtinItems.concat(customItems);
      const selectedItem = allItems.find((it) => it.id === state.bgId) || allItems[0];
      const restItems = allItems.filter((it) => it !== selectedItem);

      // The always-visible slot only gets a delete badge while expanded — a
      // selected *custom* image must still be deletable (it doesn't stop
      // being a custom image just because it's currently picked), but the
      // collapsed view (just this one thumbnail + the toggle) stays clean.
      bgControls.appendChild(buildBgThumb(selectedItem, bgExpanded && selectedItem.id.indexOf("custom:") === 0));

      const collapsibleGroup = document.createElement("div");
      Object.assign(collapsibleGroup.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        overflow: "hidden",
        maxWidth: "0px",
        transition: "max-width 250ms ease",
      });
      bgControls.appendChild(collapsibleGroup);

      const bgStatus = document.createElement("span");
      Object.assign(bgStatus.style, { fontSize: "12px", color: "#536471" });

      function populateGroup() {
        collapsibleGroup.innerHTML = "";
        restItems.forEach((item) => {
          collapsibleGroup.appendChild(buildBgThumb(item, item.id.indexOf("custom:") === 0));
        });
        collapsibleGroup.appendChild(buildUploadButton(bgStatus));
      }

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.dataset.snapcardRole = "bg-toggle";
      Object.assign(toggleBtn.style, {
        border: "none",
        background: "transparent",
        color: "#1d9bf0",
        fontSize: "12px",
        fontWeight: "600",
        cursor: "pointer",
        padding: "0",
        whiteSpace: "nowrap",
        flexShrink: "0",
      });
      function paintToggle() {
        toggleBtn.textContent = bgExpanded ? t("collapseWallpapers") : t("moreWallpapers");
      }
      paintToggle();
      toggleBtn.addEventListener("click", () => {
        bgExpanded = !bgExpanded;
        paintToggle();
        if (bgExpanded) {
          populateGroup();
          void collapsibleGroup.offsetWidth; // force layout so the 0->N transition actually animates
          collapsibleGroup.style.maxWidth = "600px";
        } else {
          collapsibleGroup.style.maxWidth = "0px";
          setTimeout(() => {
            if (!bgExpanded) collapsibleGroup.innerHTML = "";
          }, 300);
        }
      });

      if (bgExpanded) {
        // Re-rendering while already expanded (selection/upload/delete) —
        // show the full group immediately, no replay of the open animation.
        populateGroup();
        collapsibleGroup.style.transition = "none";
        collapsibleGroup.style.maxWidth = "600px";
      }

      bgControls.appendChild(toggleBtn);
      bgControls.appendChild(bgStatus);
    }
    renderBgThumbnails();
    updateBgControlsVisibility();
    styleRow.appendChild(bgControls);
    styleRow.appendChild(cardControls);

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
    Object.assign(leftControls.style, { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" });

    // "隐藏互动数据" — always available (unlike Translate, which only shows
    // up for mostly-non-Chinese text), same row/style, remembered like style.
    const hideStatsLabel = document.createElement("label");
    Object.assign(hideStatsLabel.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      fontSize: "13px",
      color: "#0f1419",
      cursor: "pointer",
    });
    const hideStatsCheckbox = document.createElement("input");
    hideStatsCheckbox.type = "checkbox";
    hideStatsCheckbox.checked = state.hideStats;
    const hideStatsText = document.createElement("span");
    hideStatsText.textContent = t("hideStatsLabel");
    hideStatsLabel.appendChild(hideStatsCheckbox);
    hideStatsLabel.appendChild(hideStatsText);
    hideStatsCheckbox.addEventListener("change", () => {
      state.hideStats = hideStatsCheckbox.checked;
      saveHideStats(state.hideStats);
      rebuildCard();
    });
    leftControls.appendChild(hideStatsLabel);

    // "隐藏时间" — same row/style/pattern as "隐藏互动数据", right after it.
    const hideTimeLabel = document.createElement("label");
    Object.assign(hideTimeLabel.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      fontSize: "13px",
      color: "#0f1419",
      cursor: "pointer",
    });
    const hideTimeCheckbox = document.createElement("input");
    hideTimeCheckbox.type = "checkbox";
    hideTimeCheckbox.checked = state.hideTime;
    const hideTimeText = document.createElement("span");
    hideTimeText.textContent = t("hideTimeLabel");
    hideTimeLabel.appendChild(hideTimeCheckbox);
    hideTimeLabel.appendChild(hideTimeText);
    hideTimeCheckbox.addEventListener("change", () => {
      state.hideTime = hideTimeCheckbox.checked;
      saveHideTime(state.hideTime);
      rebuildCard();
    });
    leftControls.appendChild(hideTimeLabel);

    // Vertical-stack toggle, only offered when it can do anything (3+
    // images — 1 and 2 images already always show in full, see
    // finalizeMediaLayout). Same pattern as the two hide toggles above.
    if ((data.images || []).length >= 3) {
      const stackLabel = document.createElement("label");
      Object.assign(stackLabel.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        color: "#0f1419",
        cursor: "pointer",
      });
      const stackCheckbox = document.createElement("input");
      stackCheckbox.type = "checkbox";
      stackCheckbox.checked = state.stackImages;
      stackCheckbox.dataset.snapcardRole = "stack-images-checkbox";
      const stackText = document.createElement("span");
      stackText.textContent = t("stackImagesLabel");
      stackLabel.appendChild(stackCheckbox);
      stackLabel.appendChild(stackText);
      stackCheckbox.addEventListener("change", () => {
        state.stackImages = stackCheckbox.checked;
        saveStackImages(state.stackImages);
        rebuildCard();
      });
      leftControls.appendChild(stackLabel);
    }

    const statusText = document.createElement("span");
    Object.assign(statusText.style, { fontSize: "12px", color: "#536471" });

    // Always offered — the translate direction adapts to the tweet instead
    // (see translateTargetLang).
    {
      const label = document.createElement("label");
      Object.assign(label.style, { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#0f1419", cursor: "pointer" });
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const labelText = document.createElement("span");
      labelText.textContent = t("translateLabel");
      label.appendChild(checkbox);
      label.appendChild(labelText);
      leftControls.appendChild(label);
      leftControls.appendChild(statusText);

      checkbox.addEventListener("change", async () => {
        if (checkbox.checked) {
          statusText.textContent = t("translatingText");
          try {
            const res = await chrome.runtime.sendMessage({
              type: "translate",
              text: data.text,
              target: translateTargetLang(data.text),
            });
            if (res && res.ok) {
              state.translatedText = res.text;
              statusText.textContent = "";
            } else {
              statusText.textContent = t("translateFailedText");
              checkbox.checked = false;
            }
          } catch (_) {
            statusText.textContent = t("translateFailedText");
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

    // Copy is the primary action (most users copy-and-paste straight into a
    // chat rather than saving a file), so it gets the primary button style
    // and goes first; Download is secondary.
    const copyBtn = makeButton(t("copyImageButton"), true);
    copyBtn.addEventListener("click", async () => {
      const originalLabel = copyBtn.textContent;
      copyBtn.disabled = true;
      copyBtn.textContent = t("downloadGeneratingText");
      try {
        // Hand the clipboard a *promise* of the PNG synchronously, while the
        // click's transient user activation is still fresh. Rendering first
        // fetches the avatar and every photo over the network, which can
        // easily outlive the ~5s activation window — and a clipboard.write()
        // issued after that window is rejected (NotAllowedError). That was
        // the "copy only works after I've clicked around a bit" bug: the
        // first render runs on a cold image cache and blows the window;
        // later renders hit the HTTP cache and squeak in.
        const blobPromise = window.SnapCard.renderCardToPng(state.exportEl, 2).then((r) => r.blob);
        let items;
        try {
          items = [new ClipboardItem({ "image/png": blobPromise })];
        } catch (_) {
          // engine can't take a Promise in ClipboardItem — await the blob
          // first (best effort; may still lose the activation window on
          // very slow networks)
          items = [new ClipboardItem({ "image/png": await blobPromise })];
        }
        await navigator.clipboard.write(items);
        copyBtn.textContent = t("copiedText");
      } catch (e) {
        copyBtn.textContent = t("copyFailedText");
      }
      setTimeout(() => {
        copyBtn.textContent = originalLabel;
        copyBtn.disabled = false;
      }, 1500);
    });

    const downloadBtn = makeButton(t("downloadPngButton"), false);
    downloadBtn.addEventListener("click", async () => {
      const originalLabel = downloadBtn.textContent;
      downloadBtn.textContent = t("downloadGeneratingText");
      downloadBtn.disabled = true;
      try {
        const { dataUrl } = await window.SnapCard.renderCardToPng(state.exportEl, 2);
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = buildFilename(data.handle);
        a.click();
      } catch (e) {
        downloadBtn.textContent = t("renderFailedText");
        setTimeout(() => (downloadBtn.textContent = originalLabel), 1500);
        downloadBtn.disabled = false;
        return;
      }
      downloadBtn.textContent = originalLabel;
      downloadBtn.disabled = false;
    });

    const closeBtn = makeButton(t("closeButton"), false);
    closeBtn.addEventListener("click", () => closeModal(host));

    rightControls.appendChild(copyBtn);
    rightControls.appendChild(downloadBtn);
    rightControls.appendChild(closeBtn);

    controls.appendChild(leftControls);
    controls.appendChild(rightControls);
    panel.appendChild(controls);

    // ----- scroll hint -----
    // panel itself is the scroll container (maxHeight:90vh, overflow:auto —
    // the controls row is a normal in-flow child and scrolls away with tall
    // content, by design, not a sticky footer). When that happens the user
    // can lose track of where the copy/download buttons went, so a small
    // pill floats over the panel's bottom-right corner as a nudge.
    //
    // It's appended to `shadow` (a sibling of `overlay`, not a child of the
    // scrolling `panel`) and positioned with position:fixed computed from
    // panel's own getBoundingClientRect() — a fixed-position descendant of
    // panel would scroll away with panel's content (its containing block is
    // panel's scrollable padding box), which defeats the purpose.
    const scrollHint = document.createElement("div");
    scrollHint.textContent = t("scrollHintText");
    Object.assign(scrollHint.style, {
      position: "fixed",
      background: "rgba(15, 20, 25, 0.85)",
      color: "#ffffff",
      fontSize: "13px",
      padding: "8px 14px",
      borderRadius: "9999px",
      pointerEvents: "none",
      transition: "opacity 0.2s ease",
      opacity: "0",
      zIndex: "2147483647",
    });

    function positionScrollHint() {
      const rect = panel.getBoundingClientRect();
      scrollHint.style.right = `${window.innerWidth - rect.right + 16}px`;
      scrollHint.style.bottom = `${window.innerHeight - rect.bottom + 16}px`;
    }

    updateScrollHint = () => {
      const overflowing = panel.scrollHeight > panel.clientHeight + 1; // +1: subpixel rounding fuzz
      if (!overflowing) {
        scrollHint.style.opacity = "0";
        return;
      }
      positionScrollHint();
      const remaining = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
      scrollHint.style.opacity = remaining < 40 ? "0" : "1";
    };
    panel.addEventListener("scroll", updateScrollHint);
    host.__snapcardResize = updateScrollHint;
    window.addEventListener("resize", updateScrollHint);

    // overlay/panel were already appended to shadow back in createModalShell
    // (phase 1) — only the scroll hint itself is new here.
    shadow.appendChild(scrollHint);
    updateScrollHint(); // panel is laid out now — set the correct initial state
  }
})();
