// SnapCard card template builder.
// Builds a fully inline-styled DOM tree for a single tweet card. Every style is
// set inline (no external CSS) so render.js can serialize the node into an SVG
// <foreignObject> without losing any styling.
//
// Exposed as window.SnapCard.buildCard(data, options),
// window.SnapCard.finalizeMediaLayout(root), and
// window.SnapCard.buildWallpaperFrame(cardEl, backgroundUrl, options).

(() => {
  "use strict";

  // One palette per card theme. "wallpaper" isn't a real palette — the
  // wallpaper style wraps either the white or dark card inside a background
  // image frame (see buildWallpaperFrame) — so buildCard only ever resolves
  // to "white" or "dark".
  const PALETTES = {
    white: {
      bg: "#ffffff",
      bgRgb: "255, 255, 255",
      text: "#0f1419",
      subtle: "#536471",
      icon: "#536471",
      hairline: "rgba(15, 20, 25, 0.08)",
      border: "rgba(15, 20, 25, 0.09)",
      wallpaperBorder: "rgba(255, 255, 255, 0.65)",
      innerHighlight: "rgba(255, 255, 255, 0.85)",
      xMark: "rgba(15, 20, 25, 0.24)",
      watermark: "#8b98a5",
      accent: "#1d9bf0",
      avatarRing: "rgba(15, 20, 25, 0.08)",
      mediaBorder: "rgba(15, 20, 25, 0.08)",
      avatarFallbackBg: "#e1e8ed",
      avatarFallbackFg: "#b7c2c9",
    },
    dark: {
      bg: "#111318",
      bgRgb: "17, 19, 24",
      text: "#f2f4f7",
      subtle: "#8b98a5",
      icon: "#8b98a5",
      hairline: "rgba(255, 255, 255, 0.10)",
      border: "rgba(255, 255, 255, 0.12)",
      wallpaperBorder: "rgba(255, 255, 255, 0.16)",
      innerHighlight: "rgba(255, 255, 255, 0.14)",
      xMark: "rgba(255, 255, 255, 0.28)",
      watermark: "#6b7785",
      accent: "#38a8f5",
      avatarRing: "rgba(255, 255, 255, 0.14)",
      mediaBorder: "rgba(255, 255, 255, 0.10)",
      avatarFallbackBg: "#252a32",
      avatarFallbackFg: "#5c6672",
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
    wrap.style.justifyContent = "center";
    wrap.style.flexShrink = "0";
    wrap.innerHTML = markup;
    return wrap;
  }

  // ---------- formatting ----------

  // Date format follows the UI language, not a fixed locale: "2026年8月19日
  // 09:41" for zh-*, "Aug 19, 2026 · 09:41" (Intl en-US) for everything
  // else. The caller may pass an explicit locale (content.js's 中/EN manual
  // override); otherwise chrome.i18n.getUILanguage() is read fresh on every
  // call (not cached) so switching the browser's language and reopening the
  // modal picks up the new format immediately — no script reload required.
  function formatTime(iso, locale) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    let uiLang = locale || "";
    if (!uiLang) {
      try {
        uiLang = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || "en";
      } catch (_) {
        uiLang = "en"; // chrome.i18n unavailable — use the English format below
      }
    }

    if (uiLang.toLowerCase().indexOf("zh") === 0) {
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
    }
    const datePart = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d);
    return `${datePart} · ${hh}:${mm}`;
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

  // ---------- icons (X official vector paths, colorblind-neutral: single muted fill + one blue accent) ----------

  const X_ICON_PATHS = {
    comment:
      "M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z",
    repost:
      "M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z",
    heart:
      "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zM20.884 13.19c-1.351 2.48-4.001 5.12-8.384 7.67l-.5.3-.5-.3c-4.383-2.55-7.033-5.19-8.384-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.797 2.01 1.429-1.45 3.146-2.1 4.797-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z",
    views:
      "M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z",
    xLogo:
      "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  };

  function iconSvg(kind, color, size) {
    const s = size || 17;
    const rule = kind === "heart" ? ' fill-rule="evenodd"' : "";
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${color}"${rule} style="display:block"><path d="${X_ICON_PATHS[kind]}"/></svg>`;
  }

  function verifiedBadgeSvg(color) {
    return `<svg width="17" height="17" viewBox="0 0 22 22" fill="${color}" style="display:block"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.446 1.055.75 1.69.882.635.132 1.294.083 1.902-.14.271.586.702 1.084 1.24 1.439.54.354 1.167.551 1.813.568.646-.016 1.276-.213 1.816-.567s.972-.853 1.245-1.44c.607.224 1.264.272 1.897.14.634-.13 1.217-.435 1.687-.88.445-.47.749-1.055.878-1.69.13-.633.081-1.29-.14-1.896.586-.274 1.084-.705 1.438-1.246.354-.54.552-1.17.57-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>`;
  }

  function avatarFallback(palette) {
    return (
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${palette.avatarFallbackBg}"/><circle cx="48" cy="38" r="18" fill="${palette.avatarFallbackFg}"/><circle cx="48" cy="96" r="38" fill="${palette.avatarFallbackFg}"/></svg>`
      )
    );
  }

  // Safely highlight @mentions, #hashtags and URLs in body text using text
  // nodes only (no innerHTML).
  function renderHighlightedText(container, rawText, accentColor) {
    const tokenRe = /(https?:\/\/[^\s]+|(?<![\w@])@[A-Za-z0-9_]{1,15}|#[^\s#.,!?;:，。！？；：、()（）[\]【】]+)/g;
    let last = 0;
    let match;
    while ((match = tokenRe.exec(rawText)) !== null) {
      if (match.index > last) {
        container.appendChild(document.createTextNode(rawText.slice(last, match.index)));
      }
      const span = el("span", { color: accentColor, fontWeight: "500" }, { textContent: match[0] });
      container.appendChild(span);
      last = tokenRe.lastIndex;
    }
    if (last < rawText.length) {
      container.appendChild(document.createTextNode(rawText.slice(last)));
    }
  }

  // ---------- media grid ----------

  function buildPlayBadge() {
    const badge = el("div", {
      position: "absolute",
      right: "10px",
      bottom: "10px",
      background: "rgba(15, 20, 25, 0.72)",
      color: "#ffffff",
      fontSize: "12px",
      fontWeight: "600",
      padding: "4px 10px",
      borderRadius: "9999px",
      display: "flex",
      alignItems: "center",
      gap: "5px",
    });
    badge.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="#ffffff"><polygon points="6,4 20,12 6,20"/></svg><span>Video</span>';
    return badge;
  }

  // Used for the 2/3/4-image grid layouts. Every cell gets an explicit
  // aspect-ratio (never a parent-driven height:100%) so its size is fully
  // self-determined from the grid column's width — this is what lets
  // buildMediaGrid's height-cap safety net (below) scale every cell by a
  // single uniform factor and just rebuild, rather than juggling two
  // different sizing strategies.
  function buildGridTile(src, ratio, extraStyle, withPlayBadge) {
    const holder = el("div", {
      position: "relative",
      overflow: "hidden",
      width: "100%",
      aspectRatio: String(ratio),
      ...extraStyle,
    });
    const img = el("img", {
      width: "100%",
      height: "100%",
      display: "block",
      objectFit: "cover",
    });
    img.src = src;
    holder.appendChild(img);
    if (withPlayBadge) holder.appendChild(buildPlayBadge());
    return holder;
  }

  // Used for the single-image layout. When X's own displayed ratio was
  // captured (extractImages), it's set as an explicit CSS aspect-ratio so
  // the tile's height is fully determined by layout *before* the image has
  // loaded. finalizeMediaLayout later locks it to the image's natural ratio
  // with maxHeight: "none".
  function buildSingleImageTile(src, hasVideo, displayRatio) {
    const holder = el("div", { position: "relative", overflow: "hidden" });
    const img = el("img", {
      width: "100%",
      height: "auto",
      maxHeight: "700px",
      display: "block",
      objectFit: "cover",
    });
    if (displayRatio) img.style.aspectRatio = String(displayRatio);
    img.src = src;
    holder.appendChild(img);
    if (hasVideo) holder.appendChild(buildPlayBadge());
    return holder;
  }

  function resolveCellRatios(list, n) {
    if (n === 2) {
      const shared = list[0].aspectRatio || 1;
      return [shared, shared];
    }
    if (n === 3) {
      return [list[0].aspectRatio || 8 / 9, list[1].aspectRatio || 16 / 9, list[2].aspectRatio || 16 / 9];
    }
    return list.map((item) => item.aspectRatio || 1);
  }

  function layoutMediaGrid(urls, ratios, hasVideo, palette) {
    const n = urls.length;
    const wrap = el("div", {
      marginTop: "14px",
      borderRadius: "14px",
      overflow: "hidden",
      border: `1px solid ${palette.mediaBorder}`,
    });

    if (n === 2) {
      Object.assign(wrap.style, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px" });
      urls.forEach((src, i) => wrap.appendChild(buildGridTile(src, ratios[i], {}, hasVideo && i === 0)));
      return wrap;
    }

    if (n === 3) {
      Object.assign(wrap.style, {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: "3px",
      });
      wrap.appendChild(buildGridTile(urls[0], ratios[0], { gridRow: "1 / span 2" }, hasVideo));
      wrap.appendChild(buildGridTile(urls[1], ratios[1], {}, false));
      wrap.appendChild(buildGridTile(urls[2], ratios[2], {}, false));
      return wrap;
    }

    // n === 4
    Object.assign(wrap.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gridTemplateRows: "1fr 1fr",
      gap: "3px",
    });
    urls.forEach((src, i) => wrap.appendChild(buildGridTile(src, ratios[i], {}, hasVideo && i === 0)));
    return wrap;
  }

  const MEDIA_MAX_HEIGHT = 900; // logical px cap on the whole media area, pre-export-scale
  const CARD_CONTENT_WIDTH = 542; // 600px card width minus 28px*2 horizontal padding minus 1px*2 border

  function buildMediaGrid(images, hasVideo, stackImages, palette) {
    if (!images || !images.length) return null;
    const list = images.slice(0, 4);
    const n = list.length;

    if (n === 1) {
      const wrap = el("div", {
        marginTop: "14px",
        borderRadius: "14px",
        overflow: "hidden",
        border: `1px solid ${palette.mediaBorder}`,
      });
      wrap.dataset.snapcardMedia = "1";
      wrap.appendChild(buildSingleImageTile(list[0].url, hasVideo, list[0].aspectRatio));
      return wrap;
    }

    if (stackImages && n >= 3) {
      const wrap = el("div", {
        marginTop: "14px",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        borderRadius: "14px",
        overflow: "hidden",
        border: `1px solid ${palette.mediaBorder}`,
      });
      wrap.dataset.snapcardMedia = "stack";
      list.forEach((item, i) => wrap.appendChild(buildGridTile(item.url, item.aspectRatio || 16 / 9, {}, hasVideo && i === 0)));
      return wrap;
    }

    const urls = list.map((item) => item.url);
    let ratios = resolveCellRatios(list, n);
    let wrap = layoutMediaGrid(urls, ratios, hasVideo, palette);

    // Safety net: measure natural height at the card's fixed content width in
    // a throwaway offscreen wrapper and shrink ratios uniformly if taller than
    // MEDIA_MAX_HEIGHT.
    const probe = el("div", { position: "fixed", left: "-9999px", top: "0", width: `${CARD_CONTENT_WIDTH}px` });
    probe.appendChild(wrap);
    document.body.appendChild(probe);
    const naturalHeight = wrap.getBoundingClientRect().height;
    document.body.removeChild(probe);

    if (naturalHeight > MEDIA_MAX_HEIGHT && naturalHeight > 0) {
      const factor = naturalHeight / MEDIA_MAX_HEIGHT;
      ratios = ratios.map((r) => r * factor);
      wrap = layoutMediaGrid(urls, ratios, hasVideo, palette);
    }

    wrap.dataset.snapcardMedia = String(n);
    return wrap;
  }

  function finalizeMediaLayout(root) {
    const wrap = root.querySelector("[data-snapcard-media]");
    if (!wrap) return;
    const kind = wrap.dataset.snapcardMedia;
    const imgs = Array.from(wrap.querySelectorAll("img"));
    const natural = (img) =>
      img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;

    if (kind === "1" && imgs[0]) {
      const r = natural(imgs[0]);
      if (r) {
        imgs[0].style.aspectRatio = String(r);
        imgs[0].style.maxHeight = "none";
      }
      return;
    }
    if (kind === "2" && imgs.length === 2) {
      const r1 = natural(imgs[0]);
      const r2 = natural(imgs[1]);
      if (r1 && r2) {
        wrap.style.gridTemplateColumns = `${r1}fr ${r2}fr`;
        imgs[0].parentElement.style.aspectRatio = String(r1);
        imgs[1].parentElement.style.aspectRatio = String(r2);
      }
      return;
    }
    if (kind === "stack") {
      imgs.forEach((img) => {
        const r = natural(img);
        if (r) img.parentElement.style.aspectRatio = String(r);
      });
    }
  }

  // ---------- stat row ----------

  function statSpan(kind, value, palette) {
    const span = el("span", {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      color: palette.icon,
      fontSize: "13.5px",
      fontWeight: "500",
      lineHeight: "1",
      fontVariantNumeric: "tabular-nums",
    });
    span.dataset.snapcardStat = kind;
    span.appendChild(svgEl(iconSvg(kind, palette.icon, 17)));
    const num = el(
      "span",
      {
        display: "inline-block",
        lineHeight: "1",
      },
      { textContent: formatCount(value || 0) }
    );
    span.appendChild(num);
    return span;
  }

  // ---------- main builder ----------

  // options: {
  //   watermark: boolean,
  //   theme: "white" | "dark",
  //   inWallpaper: boolean,
  //   opacity: number (30..100, default 100),
  //   hideStats: boolean,
  //   hideTime: boolean,
  //   stackImages: boolean,
  //   showXMark: boolean (default true),
  //   locale: string
  // }
  function buildCard(data, options) {
    data = data || {};
    options = options || {};
    const themeKey = options.theme === "dark" ? "dark" : "white";
    const palette = PALETTES[themeKey];
    const inWallpaper = !!options.inWallpaper;
    const opacity = options.opacity != null ? options.opacity : 100;
    const bgColor = opacity < 100 ? `rgba(${palette.bgRgb}, ${opacity / 100})` : palette.bg;

    const card = el("div", {
      position: "relative",
      width: "600px",
      boxSizing: "border-box",
      backgroundColor: bgColor,
      borderRadius: "20px",
      padding: "26px 28px 22px",
      border: `1px solid ${inWallpaper ? palette.wallpaperBorder : palette.border}`,
      boxShadow: inWallpaper
        ? `inset 0 1px 0 ${palette.innerHighlight}, 0 2px 4px rgba(0, 0, 0, 0.06), 0 14px 30px -6px rgba(0, 0, 0, 0.22), 0 26px 56px -14px rgba(0, 0, 0, 0.28)`
        : "none",
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif',
      WebkitFontSmoothing: "antialiased",
      color: palette.text,
    });

    // ----- header -----
    const header = el("div", {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
    });

    const authorLeft = el("div", {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      minWidth: "0",
      flex: "1",
    });

    const avatar = el("img", {
      width: "46px",
      height: "46px",
      borderRadius: "50%",
      objectFit: "cover",
      flexShrink: "0",
      background: palette.avatarFallbackBg,
      boxShadow: `0 0 0 1px ${palette.avatarRing}`,
    });
    avatar.src = data.avatar || avatarFallback(palette);
    authorLeft.appendChild(avatar);

    const nameCol = el("div", { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" });
    const nameRow = el("div", { display: "flex", alignItems: "center", gap: "5px", minWidth: "0" });
    const nameSpan = el(
      "span",
      {
        fontWeight: "700",
        fontSize: "16px",
        lineHeight: "1.3",
        letterSpacing: "-0.01em",
        color: palette.text,
        wordBreak: "break-word",
      },
      { textContent: data.displayName || "" }
    );
    nameRow.appendChild(nameSpan);
    if (data.verified) {
      nameRow.appendChild(svgEl(verifiedBadgeSvg(palette.accent)));
    }

    const metaRow = el("div", {
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: "6px",
      fontSize: "13.5px",
      lineHeight: "1.35",
      color: palette.subtle,
    });
    const handleSpan = el("span", {}, { textContent: data.handle || "" });
    metaRow.appendChild(handleSpan);

    if (!options.hideTime && data.datetime) {
      const formatted = formatTime(data.datetime, options.locale);
      if (formatted) {
        const dot = el("span", { opacity: "0.6" }, { textContent: "·" });
        const dateSpan = el(
          "span",
          { whiteSpace: "nowrap" },
          { textContent: formatted }
        );
        dateSpan.dataset.snapcardRole = "date";
        metaRow.appendChild(dot);
        metaRow.appendChild(dateSpan);
      }
    }

    nameCol.appendChild(nameRow);
    nameCol.appendChild(metaRow);
    authorLeft.appendChild(nameCol);
    header.appendChild(authorLeft);

    if (options.showXMark !== false) {
      const xBadge = el("div", {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "flex-start",
        marginTop: "2px",
        flexShrink: "0",
      });
      xBadge.dataset.snapcardRole = "x-mark";
      xBadge.appendChild(svgEl(iconSvg("xLogo", palette.xMark, 19)));
      header.appendChild(xBadge);
    }

    card.appendChild(header);

    // ----- body text -----
    // When a translation is active the card shows *only* the translation.
    const body = el("div", { marginTop: "15px" });
    const textBlock = el("div", {
      fontSize: "16.5px",
      lineHeight: "1.68",
      letterSpacing: "0.008em",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      color: palette.text,
    });
    if (data.translatedText) {
      textBlock.dataset.snapcardRole = "text-translated";
      renderHighlightedText(textBlock, data.translatedText, palette.accent);
    } else {
      textBlock.dataset.snapcardRole = "text-original";
      renderHighlightedText(textBlock, data.text || "", palette.accent);
    }
    body.appendChild(textBlock);
    card.appendChild(body);

    // ----- media -----
    const media = buildMediaGrid(data.images, !!data.hasVideo, !!options.stackImages, palette);
    if (media) card.appendChild(media);

    // ----- footer -----
    if (!options.hideStats) {
      const footer = el("div", {
        marginTop: "18px",
        paddingTop: "14px",
        borderTop: `1px solid ${palette.hairline}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      });
      footer.dataset.snapcardRole = "footer";

      const stats = data.stats || {};
      const statsRow = el("div", { display: "flex", alignItems: "center", gap: "28px" });
      statsRow.appendChild(statSpan("comment", stats.replies, palette));
      statsRow.appendChild(statSpan("repost", stats.reposts, palette));
      statsRow.appendChild(statSpan("heart", stats.likes, palette));
      statsRow.appendChild(statSpan("views", stats.views, palette));
      footer.appendChild(statsRow);

      if (options.watermark) {
        const wm = el(
          "span",
          {
            fontSize: "11.5px",
            fontWeight: "500",
            letterSpacing: "0.02em",
            color: palette.watermark,
          },
          { textContent: "SnapCard" }
        );
        footer.appendChild(wm);
      }

      card.appendChild(footer);
    } else if (options.watermark) {
      const wm = el(
        "div",
        {
          marginTop: "12px",
          textAlign: "right",
          fontSize: "11.5px",
          fontWeight: "500",
          letterSpacing: "0.02em",
          color: palette.watermark,
        },
        { textContent: "SnapCard" }
      );
      card.appendChild(wm);
    }

    return card;
  }

  // ---------- wallpaper frame ----------

  // Default equal padding on all four sides (compact 24 / medium 36 / wide 56).
  // Trimmed from the old 60px so the tweet card stays the visual hero while the
  // backdrop gradient still frames it cleanly.
  const WALLPAPER_PAD = 36;

  function buildWallpaperFrame(cardEl, backgroundUrl, options) {
    options = options || {};
    const pad = typeof options.padding === "number" && options.padding >= 0 ? Math.round(options.padding) : WALLPAPER_PAD;

    const rect = cardEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    const wrapper = el("div", {
      position: "relative",
      width: `${w + pad * 2}px`,
      height: `${h + pad * 2}px`,
      flexShrink: "0",
      boxSizing: "border-box",
      overflow: "hidden",
    });
    wrapper.dataset.snapcardRole = "wallpaper-frame";

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

    // Subtle radial light & depth vignette over the backdrop (pure CSS, safe
    // for SVG foreignObject export).
    const vignette = el("div", {
      position: "absolute",
      inset: "0",
      background:
        "radial-gradient(circle at 20% 15%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 48%), radial-gradient(circle at 85% 90%, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0) 55%)",
      pointerEvents: "none",
    });
    wrapper.appendChild(vignette);

    const centerLayer = el("div", {
      position: "absolute",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    centerLayer.dataset.snapcardRole = "wallpaper-center";
    cardEl.style.flexShrink = "0";
    centerLayer.appendChild(cardEl);
    wrapper.appendChild(centerLayer);

    return wrapper;
  }

  window.SnapCard = window.SnapCard || {};
  window.SnapCard.buildCard = buildCard;
  window.SnapCard.finalizeMediaLayout = finalizeMediaLayout;
  window.SnapCard.buildWallpaperFrame = buildWallpaperFrame;
  window.SnapCard.formatCount = formatCount;
  window.SnapCard.formatTime = formatTime;
})();
