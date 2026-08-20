// SnapCard background service worker.
// Two jobs, both stateless request/response:
//   1. fetchImage — proxy-download an image (pbs.twimg.com / video.twimg.com
//      only) and return it as base64, for the rare case a direct fetch from
//      the content script's page context fails CORS.
//   2. translate — call Google's free translate_a/single endpoint (no API
//      key) to produce a Chinese translation, with a small LRU cache.

const ALLOWED_IMAGE_HOSTS = [/(^|\.)pbs\.twimg\.com$/i, /(^|\.)video\.twimg\.com$/i];

async function handleFetchImage(url) {
  try {
    const u = new URL(url);
    const allowed = ALLOWED_IMAGE_HOSTS.some((re) => re.test(u.hostname));
    if (!allowed) return { ok: false, error: `host not allowed: ${u.hostname}` };

    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };

    const mime = (resp.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 32768; // avoid String.fromCharCode stack overflow on large images
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { ok: true, base64: btoa(bin), mime };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- translation (Google free endpoint, LRU cache) ----------

const CACHE_MAX = 200;
const TIMEOUT_MS = 10000;
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v); // move to most-recently-used
  return v;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

async function translateLine(text, target) {
  if (!text || !text.trim()) return text; // keep blank lines as-is
  const key = target + "|" + text;
  const hit = cacheGet(key);
  if (hit != null) return hit;

  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
    encodeURIComponent(target) +
    "&dt=t&q=" +
    encodeURIComponent(text);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const translated = (data[0] || []).map((seg) => seg[0] || "").join("");
    cacheSet(key, translated);
    return translated;
  } finally {
    clearTimeout(timer);
  }
}

// Translate line-by-line so paragraph breaks in the original tweet are kept.
// `target` defaults to "zh-CN" for backward compatibility with any caller
// that still sends the old two-field { type, text } message shape; content.js
// now always sends target explicitly (zh-CN for a Chinese UI, en otherwise —
// see translateTargetLang() there).
async function handleTranslate(text, target) {
  try {
    const tl = target || "zh-CN";
    const lines = String(text == null ? "" : text).split("\n");
    const translatedLines = await Promise.all(lines.map((line) => translateLine(line, tl)));
    return { ok: true, text: translatedLines.join("\n") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Raw _locales/*/messages.json for content.js's manual 中/EN UI-language
// override — chrome.i18n can only speak the browser's own language, so an
// explicit choice needs the packaged file itself. Only the background can
// fetch chrome-extension:// URLs without a web_accessible_resources entry.
const localeMessagesCache = {};
async function handleGetMessages(lang) {
  const dir = lang === "zh" ? "zh_CN" : "en";
  try {
    if (!localeMessagesCache[dir]) {
      const res = await fetch(chrome.runtime.getURL(`_locales/${dir}/messages.json`));
      localeMessagesCache[dir] = await res.json();
    }
    return { ok: true, messages: localeMessagesCache[dir] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "fetchImage") {
    handleFetchImage(msg.url).then(sendResponse);
    return true; // async response
  }

  if (msg.type === "translate") {
    handleTranslate(msg.text, msg.target).then(sendResponse);
    return true; // async response
  }

  if (msg.type === "getMessages") {
    handleGetMessages(msg.lang).then(sendResponse);
    return true; // async response
  }

  return false;
});
