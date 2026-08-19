// SnapCard popup: single setting — whether to show the "SnapCard" watermark.

(() => {
  "use strict";

  // Static text in popup.html is already written in English (the fallback
  // that stays on screen if chrome.i18n is ever unavailable) — data-i18n /
  // data-i18n-alt attributes mark the elements to overwrite with
  // chrome.i18n.getMessage() once the real API is available, same idea as
  // content.js's t() helper but simpler since there's no dynamic content here.
  function localizedMessage(key) {
    try {
      const msg = chrome.i18n.getMessage(key);
      if (msg) return msg;
    } catch (_) {
      // chrome.i18n unavailable — leave the English fallback already in the DOM
    }
    return null;
  }

  try {
    document.documentElement.lang = chrome.i18n.getUILanguage() || "en";
  } catch (_) {
    // leave the static lang="en" from popup.html
  }

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = localizedMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    const msg = localizedMessage(el.dataset.i18nAlt);
    if (msg) el.alt = msg;
  });

  const toggle = document.getElementById("watermark-toggle");

  chrome.storage.sync.get({ watermark: false }, (res) => {
    toggle.checked = !!res.watermark;
  });

  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ watermark: toggle.checked });
  });
})();
