// SnapCard renderer: DOM card -> PNG.
// Pipeline: clone -> measure off-screen -> inline all <img> as data URLs ->
// serialize to an XHTML fragment inside an SVG <foreignObject> -> load as an
// <img> via a data: URL -> draw to a scaled canvas -> export PNG.
//
// Exposed as window.SnapCard.renderCardToPng(cardElement, scale).

(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  // Try direct fetch first (pbs.twimg.com sends permissive CORS headers), fall
  // back to the background service worker proxy for hosts that don't.
  async function fetchAsDataUrl(url) {
    if (!url) return null;
    if (url.startsWith("data:")) return url;
    try {
      const resp = await fetch(url, { mode: "cors" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      return await blobToDataUrl(blob);
    } catch (_) {
      // fall through to background proxy
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: "fetchImage", url });
      if (res && res.ok) return `data:${res.mime};base64,${res.base64}`;
    } catch (_) {
      // background unreachable; give up on this image
    }
    return null;
  }

  async function inlineImages(root) {
    const imgs = Array.from(root.querySelectorAll("img"));
    await Promise.all(
      imgs.map(async (img) => {
        const src = img.getAttribute("src");
        const dataUrl = await fetchAsDataUrl(src);
        if (dataUrl) {
          img.setAttribute("src", dataUrl);
        } else {
          // Can't inline this image (network/proxy failure) — drop it rather
          // than leaving a broken-image icon or a cross-origin src that would
          // taint the canvas.
          img.removeAttribute("src");
        }
        img.removeAttribute("crossorigin");
      })
    );
  }

  function serializeToSvg(node, width, height) {
    const clone = node.cloneNode(true);
    clone.setAttribute("xmlns", XHTML_NS);
    const xhtml = new XMLSerializer().serializeToString(clone);
    return (
      `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject width="100%" height="100%">${xhtml}</foreignObject>` +
      `</svg>`
    );
  }

  function loadSvgImage(svgString, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.width = width;
      img.height = height;
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load serialized SVG card"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString);
    });
  }

  async function renderCardToPng(cardElement, scale) {
    scale = scale || 2;

    // Mount an off-screen clone (images still point at their original remote
    // URLs) so layout/aspect-ratio boxes resolve to real pixel sizes without
    // waiting on network round trips. The offscreen positioning goes on a
    // wrapper, never on the clone itself — the clone is what gets serialized
    // into the SVG, and if it inherited "position: fixed; left: -9999px" the
    // foreignObject content would render outside the SVG's own coordinate
    // space, producing a blank PNG.
    const measureClone = cardElement.cloneNode(true);
    const offscreenWrapper = document.createElement("div");
    Object.assign(offscreenWrapper.style, { position: "fixed", left: "-9999px", top: "0" });
    offscreenWrapper.appendChild(measureClone);
    document.body.appendChild(offscreenWrapper);
    const rect = measureClone.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(rect.width));
    const height = Math.max(1, Math.ceil(rect.height));

    await inlineImages(measureClone);
    const svgString = serializeToSvg(measureClone, width, height);
    document.body.removeChild(offscreenWrapper);

    const svgImage = await loadSvgImage(svgString, width, height);

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(svgImage, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const dataUrl = canvas.toDataURL("image/png");
    return { canvas, blob, dataUrl };
  }

  window.SnapCard = window.SnapCard || {};
  window.SnapCard.renderCardToPng = renderCardToPng;
})();
