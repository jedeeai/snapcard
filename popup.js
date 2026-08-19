// SnapCard popup: single setting — whether to show the "SnapCard" watermark.

(() => {
  "use strict";

  const toggle = document.getElementById("watermark-toggle");

  chrome.storage.sync.get({ watermark: false }, (res) => {
    toggle.checked = !!res.watermark;
  });

  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ watermark: toggle.checked });
  });
})();
