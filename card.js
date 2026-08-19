// SnapCard card template builder.
// Builds a fully inline-styled DOM tree for a single tweet card. Every style is
// set inline (no external CSS) so render.js can serialize the node into an SVG
// <foreignObject> without losing any styling.
//
// Exposed as window.SnapCard.buildCard(data, options) and
// window.SnapCard.buildWallpaperFrame(cardEl, backgroundUrl).

(() => {
  "use strict";

  // One palette per card theme. "wallpaper" isn't a real palette — the
  // wallpaper style is always the white card, just framed on a background
  // image (see buildWallpaperFrame) — so buildCard only ever resolves to
  // "white" or "dark".
  const PALETTES = {
    white: {
      bg: "#ffffff",
      text: "#0f1419",
      subtle: "#536471",
      hairline: "#eff3f4",
      watermark: "#8b98a5",
      accent: "#1d9bf0",
      avatarFallbackBg: "#e1e8ed",
      avatarFallbackFg: "#b7c2c9",
    },
    dark: {
      bg: "#000000",
      text: "#e7e9ea",
      subtle: "#71767b",
      hairline: "#2f3336",
      watermark: "#536471",
      accent: "#1d9bf0",
      avatarFallbackBg: "#2f3336",
      avatarFallbackFg: "#536471",
    },
  };

  // ---------- small DOM helpers ----------

  function el(tag, style, props) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (props) Object.assign(node, props);
    return node;
  }

  function svgEl(markup) {
    const wrap = document.createElement("span");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.innerHTML = markup;
    return wrap;
  }

  // ---------- formatting ----------

  // "9:41 · Aug 19, 2026"
  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const h24 = d.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${h12}:${mm} · ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  // Large-number abbreviation: 1210 -> "1.21K", 2680000 -> "2.68M". Numbers
  // under 1000 are left as-is. K/M/B kept as-is per spec (no 万/亿 conversion).
  function formatCount(n) {
    if (n == null || isNaN(n)) return "0";
    const abs = Math.abs(n);
    if (abs < 1000) return String(n);
    const units = [
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"],
    ];
    for (const [div, suffix] of units) {
      if (abs >= div) {
        const v = n / div;
        let s;
        if (v >= 100) s = String(Math.round(v));
        else if (v >= 10) s = v.toFixed(1).replace(/\.0$/, "");
        else s = v.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
        return s + suffix;
      }
    }
    return String(n);
  }

  // ---------- icons (inline, colorblind-neutral: single outline color + one blue accent) ----------
  // Stroke color is parametrized per-palette (see statSpan) so the icons read
  // correctly against both the white and dark card backgrounds.

  const ICON_PATHS = {
    comment:
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    repost:
      '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    heart:
      '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
    views: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  };

  function iconSvg(kind, color) {
    return (
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[kind]}</svg>`
    );
  }

  function verifiedBadgeSvg(color) {
    return `<svg width="16" height="16" viewBox="0 0 22 22" fill="${color}"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.446 1.055.75 1.69.882.635.132 1.294.083 1.902-.14.271.586.702 1.084 1.24 1.439.54.354 1.167.551 1.813.568.646-.016 1.276-.213 1.816-.567s.972-.853 1.245-1.44c.607.224 1.264.272 1.897.14.634-.13 1.217-.435 1.687-.88.445-.47.749-1.055.878-1.69.13-.633.081-1.29-.14-1.896.586-.274 1.084-.705 1.438-1.246.354-.54.552-1.17.57-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>`;
  }

  function avatarFallback(palette) {
    return (
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${palette.avatarFallbackBg}"/><circle cx="48" cy="38" r="18" fill="${palette.avatarFallbackFg}"/><circle cx="48" cy="96" r="38" fill="${palette.avatarFallbackFg}"/></svg>`
      )
    );
  }

  // ---------- media grid ----------

  function buildPlayBadge() {
    const badge = el("div", {
      position: "absolute",
      right: "8px",
      bottom: "8px",
      background: "rgba(0,0,0,0.65)",
      color: "#ffffff",
      fontSize: "12px",
      fontWeight: "600",
      padding: "3px 8px",
      borderRadius: "9999px",
      display: "flex",
      alignItems: "center",
      gap: "4px",
    });
    badge.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="#ffffff"><polygon points="6,4 20,12 6,20"/></svg><span>Video</span>';
    return badge;
  }

  // Used for the 2/3/4-image grid layouts, where every cell has a *definite*
  // size (aspect-ratio on the grid wrap resolves each 1fr row/column to real
  // pixels), so the <img> can always fill it at 100%/100% and let
  // object-fit:cover crop it — cropping to a fixed grid is the point there.
  function buildGridTile(src, tileStyle, withPlayBadge) {
    const holder = el("div", { position: "relative", overflow: "hidden", ...tileStyle });
    const img = el("img", {
      width: "100%",
      height: "100%",
      display: "block",
      objectFit: "cover",
    });
    img.src = src;
    // No crossOrigin here — this is the *visible* preview image. Setting it
    // would make the <img> request go CORS-mode and risk a broken-image icon
    // if a host doesn't answer the preflight cleanly. render.js's export
    // pipeline clones the card and inlines every image as a data URL
    // separately, so canvas-taint isn't a concern on this live node.
    holder.appendChild(img);
    if (withPlayBadge) holder.appendChild(buildPlayBadge());
    return holder;
  }

  // Used for the single-image layout: keep the image's own aspect ratio
  // (width:100%, height:auto) instead of forcing it into a fixed box, only
  // cropping via object-fit:cover once it would exceed max-height — so a
  // wide landscape photo isn't squashed into a square/16:9 crop that cuts
  // off its sides.
  function buildSingleImageTile(src, hasVideo) {
    const holder = el("div", { position: "relative", overflow: "hidden", borderRadius: "16px" });
    const img = el("img", {
      width: "100%",
      height: "auto",
      maxHeight: "700px",
      display: "block",
      objectFit: "cover",
      borderRadius: "16px",
    });
    img.src = src;
    holder.appendChild(img);
    if (hasVideo) holder.appendChild(buildPlayBadge());
    return holder;
  }

  function buildMediaGrid(images, hasVideo) {
    if (!images || !images.length) return null;
    const list = images.slice(0, 4);
    const n = list.length;

    if (n === 1) {
      const wrap = el("div", { marginTop: "16px" });
      wrap.appendChild(buildSingleImageTile(list[0], hasVideo));
      return wrap;
    }

    const wrap = el("div", { marginTop: "16px", borderRadius: "16px", overflow: "hidden" });

    if (n === 2) {
      Object.assign(wrap.style, {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "4px",
        aspectRatio: "16/9",
      });
      list.forEach((src, i) =>
        wrap.appendChild(buildGridTile(src, { width: "100%", height: "100%" }, hasVideo && i === 0))
      );
      return wrap;
    }

    if (n === 3) {
      Object.assign(wrap.style, {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: "4px",
        aspectRatio: "16/9",
      });
      wrap.appendChild(
        buildGridTile(list[0], { width: "100%", height: "100%", gridRow: "1 / span 2" }, hasVideo)
      );
      wrap.appendChild(buildGridTile(list[1], { width: "100%", height: "100%" }));
      wrap.appendChild(buildGridTile(list[2], { width: "100%", height: "100%" }));
      return wrap;
    }

    // n === 4
    Object.assign(wrap.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gridTemplateRows: "1fr 1fr",
      gap: "4px",
      aspectRatio: "1/1",
    });
    list.forEach((src, i) =>
      wrap.appendChild(buildGridTile(src, { width: "100%", height: "100%" }, hasVideo && i === 0))
    );
    return wrap;
  }

  // ---------- stat row ----------

  function statSpan(kind, value, palette) {
    const span = el("span", {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      color: palette.subtle,
      fontSize: "13px",
    });
    span.appendChild(svgEl(iconSvg(kind, palette.subtle)));
    const num = el("span", {}, { textContent: formatCount(value || 0) });
    span.appendChild(num);
    return span;
  }

  // ---------- main builder ----------

  // options: { watermark: boolean, theme: "white" | "dark" | "wallpaper" }
  // "wallpaper" resolves to the white palette here — the wallpaper framing
  // itself is a separate step, see buildWallpaperFrame below.
  function buildCard(data, options) {
    data = data || {};
    options = options || {};
    const palette = PALETTES[options.theme === "dark" ? "dark" : "white"];

    const card = el("div", {
      position: "relative",
      width: "600px",
      boxSizing: "border-box",
      background: palette.bg,
      borderRadius: "20px",
      padding: "32px",
      fontFamily: '-apple-system, "PingFang SC", "Segoe UI", sans-serif',
      color: palette.text,
    });

    // ----- header -----
    const header = el("div", { display: "flex", alignItems: "center", gap: "12px" });
    const avatar = el("img", {
      width: "48px",
      height: "48px",
      borderRadius: "50%",
      objectFit: "cover",
      flexShrink: "0",
      background: palette.avatarFallbackBg,
    });
    avatar.src = data.avatar || avatarFallback(palette);
    header.appendChild(avatar);

    const nameCol = el("div", { display: "flex", flexDirection: "column", minWidth: "0" });
    const nameRow = el("div", { display: "flex", alignItems: "center", gap: "4px" });
    const nameSpan = el(
      "span",
      {
        fontWeight: "700",
        fontSize: "16px",
        color: palette.text,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      { textContent: data.displayName || "" }
    );
    nameRow.appendChild(nameSpan);
    if (data.verified) nameRow.appendChild(svgEl(verifiedBadgeSvg(palette.accent)));
    const handleSpan = el(
      "span",
      { color: palette.subtle, fontSize: "14px" },
      { textContent: data.handle || "" }
    );
    nameCol.appendChild(nameRow);
    nameCol.appendChild(handleSpan);
    header.appendChild(nameCol);
    card.appendChild(header);

    // ----- body text -----
    const body = el("div", { marginTop: "16px" });
    const original = el("div", {
      fontSize: "17px",
      lineHeight: "1.65",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      color: palette.text,
    });
    original.textContent = data.text || "";
    original.dataset.snapcardRole = "text-original";
    body.appendChild(original);

    if (data.translatedText) {
      const divider = el("div", { height: "1px", background: palette.hairline, margin: "12px 0" });
      const translated = el("div", {
        fontSize: "17px",
        lineHeight: "1.65",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: palette.text,
      });
      translated.dataset.snapcardRole = "text-translated";
      translated.textContent = data.translatedText;
      body.appendChild(divider);
      body.appendChild(translated);
    }
    card.appendChild(body);

    // ----- media -----
    const media = buildMediaGrid(data.images, !!data.hasVideo);
    if (media) card.appendChild(media);

    // ----- footer -----
    const footer = el("div", {
      marginTop: "16px",
      paddingTop: "12px",
      borderTop: `1px solid ${palette.hairline}`,
    });
    const timeRow = el(
      "div",
      { fontSize: "13px", color: palette.subtle },
      { textContent: formatTime(data.datetime) }
    );
    footer.appendChild(timeRow);

    const stats = data.stats || {};
    const statsRow = el("div", { display: "flex", alignItems: "center", gap: "16px", marginTop: "6px" });
    statsRow.appendChild(statSpan("comment", stats.replies, palette));
    statsRow.appendChild(statSpan("repost", stats.reposts, palette));
    statsRow.appendChild(statSpan("heart", stats.likes, palette));
    statsRow.appendChild(statSpan("views", stats.views, palette));
    footer.appendChild(statsRow);
    card.appendChild(footer);

    // ----- watermark -----
    if (options.watermark) {
      const wm = el(
        "div",
        {
          marginTop: "8px",
          textAlign: "right",
          fontSize: "11px",
          color: palette.watermark,
        },
        { textContent: "SnapCard" }
      );
      card.appendChild(wm);
    }

    return card;
  }

  // ---------- wallpaper frame ----------

  // Wraps an already-mounted (laid out) card element in a background-image
  // frame: canvas padded ~15% of the card's own width/height on each side,
  // background image cover-cropped to fill it, card given a soft drop shadow.
  // Must be called after cardEl is attached to a live, visible document —
  // getBoundingClientRect needs real layout to measure against.
  function buildWallpaperFrame(cardEl, backgroundUrl) {
    const rect = cardEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const padX = Math.round(w * 0.15);
    const padY = Math.round(h * 0.15);

    const wrapper = el("div", {
      position: "relative",
      width: `${w + padX * 2}px`,
      height: `${h + padY * 2}px`,
      boxSizing: "border-box",
      overflow: "hidden",
    });

    // Background layer: a plain <img> (not CSS background-image) so
    // render.js's existing "find every <img> and inline it as a data URL"
    // pipeline picks it up automatically, no special-casing needed.
    const bg = el("img", {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block",
    });
    bg.dataset.snapcardRole = "wallpaper-bg";
    bg.src = backgroundUrl;
    wrapper.appendChild(bg);

    const centerLayer = el("div", {
      position: "absolute",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    cardEl.style.boxShadow = "0 25px 50px rgba(0, 0, 0, 0.35)";
    cardEl.style.flexShrink = "0";
    centerLayer.appendChild(cardEl); // reparents cardEl out of its old position
    wrapper.appendChild(centerLayer);

    return wrapper;
  }

  window.SnapCard = window.SnapCard || {};
  window.SnapCard.buildCard = buildCard;
  window.SnapCard.buildWallpaperFrame = buildWallpaperFrame;
  window.SnapCard.formatCount = formatCount;
  window.SnapCard.formatTime = formatTime;
})();
