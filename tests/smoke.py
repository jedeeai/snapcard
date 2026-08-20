#!/usr/bin/env python3
# SnapCard smoke test: mock page + mock chrome API, playwright headless.
# UI is Simplified Chinese, so this test matches on the actual on-screen
# button text (下载 PNG, 黑色, 壁纸, ...) rather than English labels.
# No login, no real x.com — verifies:
#   1) the "生成卡片" button gets injected into the tweet's action bar
#   2) clicking it opens the preview modal (shadow DOM) with the card's name text
#   3) clicking "下载 PNG" runs the full render pipeline without a JS error
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK = "file://" + os.path.join(ROOT, "tests", "mock.html")

# Load the *real* shipped message files (not a hand-copied duplicate) so the
# mock's chrome.i18n.getMessage() renders exactly what the real extension
# would — see the i18n mock comment in tests/mock.html. Injected via
# add_init_script below (i.e. before mock.html's own inline <script>, and
# therefore before card.js/content.js ever call chrome.i18n.*).
with open(os.path.join(ROOT, "_locales", "en", "messages.json"), encoding="utf-8") as f:
    I18N_EN = json.load(f)
with open(os.path.join(ROOT, "_locales", "zh_CN", "messages.json"), encoding="utf-8") as f:
    I18N_ZH_CN = json.load(f)

fails = []
console_errors = []
page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()

    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("download", lambda d: None)  # avoid hanging on the data: URL download

    # #tweet-long's photo is an http URL served through route interception
    # with an artificial delay — simulating a real pbs.twimg.com image that
    # arrives only *after* the card DOM has been built, the exact condition
    # that used to make the one-time measurements (wallpaper frame, preview
    # scale) run against a still-0px-tall image. 500x900 = a tall portrait.
    TALL_SVG = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="900">'
        '<rect width="500" height="900" fill="#4477aa"/>'
        '<circle cx="250" cy="450" r="180" fill="#ddaa33"/></svg>'
    )

    def serve_tall_image(route):
        time.sleep(0.4)
        route.fulfill(status=200, content_type="image/svg+xml", body=TALL_SVG)

    page.route(re.compile(r"snapcard\.mock/tall\.svg"), serve_tall_image)

    page.add_init_script(
        "window.__snapcardI18nMessages = %s; window.__snapcardLocale = 'zh-CN';"
        % json.dumps({"en": I18N_EN, "zh_CN": I18N_ZH_CN})
    )

    page.goto(MOCK)
    page.wait_for_timeout(200)

    # ---- 1) button injected (mock.html has 4 articles — the main mock
    # tweet, #tweet-2col for the two-image layout test, #tweet-3pic for the
    # stack-mode test, and #tweet-long for the slow-image regression) ----
    btn_count = page.locator("article .snapcard-btn").count()
    print("1) buttons injected across articles:", btn_count)
    if btn_count != 4:
        fails.append(f"expected exactly 4 .snapcard-btn (one per mock article), got {btn_count}")

    # ---- 2) click opens modal; a loading spinner shows immediately (before
    # extraction/settings-read finishes), then the card replaces it. Checked
    # with zero wait right after .click() — Playwright's click() only returns
    # once the browser has dispatched and processed the event, i.e. after the
    # click handler's synchronous portion (through its first await) has run,
    # so the spinner must already be in the DOM at this point if the "open
    # modal immediately, build the card asynchronously" behavior is real.
    # (Scoped to the main mock tweet, not #tweet-2col.) ----
    page.locator('article:not(#tweet-2col):not(#tweet-long):not(#tweet-3pic) .snapcard-btn').click()
    spinner_immediately = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return null;
          const wrap = host.shadowRoot.querySelector('[data-snapcard-role="loading-wrap"]');
          return wrap ? wrap.textContent : null;
        }"""
    )
    print("2) loading spinner present immediately after click:", spinner_immediately)
    if not spinner_immediately or "卡片生成中" not in spinner_immediately:
        fails.append(f"expected loading spinner text containing '卡片生成中' immediately after click, got {spinner_immediately!r}")

    page.wait_for_timeout(300)

    spinner_after = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          return host && host.shadowRoot ? !!host.shadowRoot.querySelector('[data-snapcard-role="loading-wrap"]') : false;
        }"""
    )
    print("   loading spinner gone after render:", not spinner_after)
    if spinner_after:
        fails.append("loading spinner still present after the card should have finished rendering")

    shadow_text = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return null;
          return host.shadowRoot.textContent;
        }"""
    )
    print("2) shadow root text present:", shadow_text is not None)
    if shadow_text is None:
        fails.append("modal host / shadowRoot not found after clicking the button")
    else:
        if "Jack" not in shadow_text:
            fails.append(f"expected display name 'Jack' in card, shadow text was: {shadow_text[:200]!r}")
        if "@jack" not in shadow_text:
            fails.append(f"expected handle '@jack' in card, shadow text was: {shadow_text[:200]!r}")
        # The mock's User-Name carries a third-party injected badge
        # (.xtb-badge with <img alt="已收录">, mirroring x-track-badge).
        # Its alt text must NOT leak into the card as if it were emoji text.
        if "已收录" in shadow_text:
            fails.append(f"injected .xtb-badge alt text '已收录' leaked into the card, shadow text was: {shadow_text[:300]!r}")
        print("   name/handle found in shadow text, injected badge filtered: OK")

    # ---- 2b) body text renders as exactly 1 visual line (no bogus emoji-
    # induced line break / indentation from whitespace-only text nodes in the
    # source markup — getClientRects() returns one rect per wrapped line, so
    # this is a real rendering check, not just an extracted-string check) ----
    line_count = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const el = host.shadowRoot.querySelector('[data-snapcard-role="text-original"]');
          if (!el) return null;
          return el.getClientRects().length;
        }"""
    )
    body_text = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const el = host.shadowRoot.querySelector('[data-snapcard-role="text-original"]');
          return el ? el.textContent : null;
        }"""
    )
    print(f"2b) body text line count: {line_count} (text: {body_text!r})")
    if line_count != 1:
        fails.append(f"expected mock tweet body to render as 1 line, got {line_count} (text: {body_text!r})")

    # ---- 2c) date is Chinese-formatted and lives next to the name/badge, not
    # in the footer. The expected "YYYY年M月D日" prefix is computed by asking
    # the browser to parse the mock's own datetime attribute (rather than
    # hardcoding a date string in Python), so this doesn't depend on the test
    # machine's timezone rolling the calendar day over. ----
    expected_date_prefix = page.evaluate(
        """() => {
          const d = new Date('2026-08-19T01:41:00.000Z');
          return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        }"""
    )
    date_span_text = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const el = host.shadowRoot.querySelector('[data-snapcard-role="date"]');
          return el ? el.textContent : null;
        }"""
    )
    footer_text = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const el = host.shadowRoot.querySelector('[data-snapcard-role="footer"]');
          return el ? el.textContent : null;
        }"""
    )
    print(f"2c) date span: {date_span_text!r} (expected prefix {expected_date_prefix!r}), footer: {footer_text!r}")
    if not date_span_text or expected_date_prefix not in date_span_text:
        fails.append(f"expected date '{expected_date_prefix}' next to the name/badge, got {date_span_text!r}")
    english_months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    if footer_text is None:
        fails.append("footer (data-snapcard-role=footer) not found")
    elif any(m in footer_text for m in english_months):
        fails.append(f"footer still contains an English month abbreviation: {footer_text!r}")

    # ---- 3) click 下载 PNG, expect no JS error ----
    clicked = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return false;
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '下载 PNG');
          if (!btn) return false;
          btn.click();
          return true;
        }"""
    )
    print("3) 下载 PNG button clicked:", clicked)
    if not clicked:
        fails.append("下载 PNG button not found in modal")
    else:
        # rendering is async (image inlining + canvas); give it time to finish
        page.wait_for_timeout(1500)
        label = page.evaluate(
            """() => {
              const host = document.getElementById('snapcard-host');
              const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
              const btn = btns.find((b) => b.textContent.trim() === '下载 PNG' || b.textContent.trim() === '生成中…' || b.textContent.trim() === '渲染失败');
              return btn ? btn.textContent.trim() : null;
            }"""
        )
        print("   post-render button label:", label)
        if label == "渲染失败":
            fails.append("下载 PNG render pipeline reported failure (渲染失败)")

    # ---- 4) the render pipeline must actually paint content, not a blank canvas ----
    # (a previous bug had the export succeed with no error while producing an
    # all-white PNG, because the off-screen measurement clone's own inline
    # style — position:fixed;left:-9999px — got serialized straight into the
    # foreignObject; this check would have caught it.)
    pixel_info = page.evaluate(
        """async () => {
          const host = document.getElementById('snapcard-host');
          // host.__snapcardExportEl is the real, unscaled node — the visible
          // preview only ever shows a *scaled clone* of it now (fit-to-view),
          // so querying the shadow DOM for "the card" would grab that scaled
          // clone instead and produce a shrunk canvas.
          const cardNode = host.__snapcardExportEl;
          if (!cardNode) return { error: 'card node not found' };
          const { canvas } = await window.SnapCard.renderCardToPng(cardNode, 1);
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let nonWhite = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) nonWhite++;
          }
          return { width: canvas.width, height: canvas.height, nonWhite };
        }"""
    )
    print("4) rendered canvas pixel check:", pixel_info)
    if pixel_info.get("error"):
        fails.append(f"pixel check failed: {pixel_info['error']}")
    elif not pixel_info.get("nonWhite"):
        fails.append("rendered PNG is entirely white/blank — card content did not paint")

    # ---- 5) Style selector has exactly the 3 expected options ----
    style_labels = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const btns = Array.from(shadow.querySelectorAll('button'));
          return btns.map((b) => b.textContent.trim()).filter((t) => ['白色', '黑色', '壁纸'].includes(t));
        }"""
    )
    print("5) style selector options found:", style_labels)
    for expected in ("白色", "黑色", "壁纸"):
        if expected not in style_labels:
            fails.append(f"style selector missing '{expected}' option")

    # ---- 6) switching to 黑色 (Dark) actually changes the card's background color ----
    bg_before = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cardNode = host.__snapcardExportEl;
          return cardNode ? cardNode.style.backgroundColor : null; // .style, not getComputedStyle — cardNode is a detached node now (see __snapcardExportEl comment above), getComputedStyle returns '' for detached nodes
        }"""
    )
    clicked_dark = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const btns = Array.from(shadow.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '黑色');
          if (!btn) return false;
          btn.click();
          return true;
        }"""
    )
    page.wait_for_timeout(150)
    bg_after = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cardNode = host.__snapcardExportEl;
          return cardNode ? cardNode.style.backgroundColor : null; // .style, not getComputedStyle — cardNode is a detached node now (see __snapcardExportEl comment above), getComputedStyle returns '' for detached nodes
        }"""
    )
    print(f"6) 黑色 clicked={clicked_dark}, background {bg_before!r} -> {bg_after!r}")
    if not clicked_dark:
        fails.append("could not click the '黑色' style button")
    elif bg_after != "rgb(0, 0, 0)":
        fails.append(f"expected card background rgb(0, 0, 0) after switching to 黑色, got {bg_after!r}")
    elif bg_before == bg_after:
        fails.append("card background did not change when switching from 白色 to 黑色")

    # ---- 7) switching to 壁纸 (Wallpaper) actually loads the real background image ----
    # (mock's chrome.runtime.getURL resolves to the real assets/bg-aurora.jpg
    # on disk — a previous mock stood in a synthetic 1x1 data: URI instead,
    # which is why an earlier screenshot review showed a blank white frame;
    # naturalWidth 1400 here proves the real file — the self-made gradient
    # that replaced the Apple wallpapers on 2026-08-20, see CLAUDE.md fault
    # log — decoded successfully in the live preview, not just some image.)
    clicked_wallpaper = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const btns = Array.from(shadow.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '壁纸');
          if (!btn) return false;
          btn.click();
          return true;
        }"""
    )
    page.wait_for_timeout(300)
    bg_img_info = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const bg = host.shadowRoot.querySelector('[data-snapcard-role="wallpaper-bg"]');
          if (!bg) return null;
          return { naturalWidth: bg.naturalWidth, naturalHeight: bg.naturalHeight, complete: bg.complete };
        }"""
    )
    print(f"7) 壁纸 clicked={clicked_wallpaper}, background image: {bg_img_info}")
    if not clicked_wallpaper:
        fails.append("could not click the '壁纸' style button")
    elif not bg_img_info:
        fails.append("wallpaper background <img data-snapcard-role=wallpaper-bg> not found")
    elif not bg_img_info.get("naturalWidth"):
        fails.append("wallpaper background image did not actually decode (naturalWidth is 0)")
    elif bg_img_info.get("naturalWidth") != 1400:
        fails.append(f"expected default background bg-aurora.jpg to load at naturalWidth 1400, got {bg_img_info}")

    # NOTE: we deliberately do NOT run the full PNG-export pipeline
    # (renderCardToPng) on the Wallpaper frame here. render.js's inlineImages()
    # calls fetch(url, {mode:'cors'}) to turn every <img> into a data URL
    # before rasterizing, and this test harness loads mock.html itself via
    # file://, so the background's resolved file:// URL makes that fetch()
    # throw ("URL scheme file is not supported") — a real Chrome restriction
    # on fetch-to-file, not a product bug. In the real extension the
    # background always resolves to either a data: URL (a user-uploaded
    # custom background, already inlined) or a chrome-extension:// URL (the
    # bundled default, fetchable because assets/* is declared in
    # web_accessible_resources) — neither of those hits this restriction.

    # ---- 7b) wallpaper padding is equal on all 4 sides (fixed 60px, not a
    # percentage of the card's own width/height — a real user screenshot
    # showed visibly uneven top/bottom vs left/right margins on a tall card
    # under the old percentage-based padding) ----
    pad_info = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          // host.__snapcardExportEl (the real frame) is detached — the
          // preview only ever mounts a *scaled clone* of it now — so mount a
          // fresh clone off-screen ourselves to get real, unscaled numbers.
          const original = host.__snapcardExportEl;
          if (!original) return null;
          const clone = original.cloneNode(true);
          const probe = document.createElement('div');
          Object.assign(probe.style, { position: 'fixed', left: '-9999px', top: '0' });
          probe.appendChild(clone);
          document.body.appendChild(probe);
          const card = clone.querySelector('[style*="width: 600px"]');
          if (!card) { document.body.removeChild(probe); return null; }
          const f = clone.getBoundingClientRect();
          const c = card.getBoundingClientRect();
          document.body.removeChild(probe);
          return {
            left: Math.round(c.left - f.left),
            right: Math.round(f.right - c.right),
            top: Math.round(c.top - f.top),
            bottom: Math.round(f.bottom - c.bottom),
          };
        }"""
    )
    print("7b) wallpaper frame padding (l/r/t/b):", pad_info)
    if not pad_info:
        fails.append("wallpaper frame or card node not found for padding check")
    else:
        vals = (pad_info["left"], pad_info["right"], pad_info["top"], pad_info["bottom"])
        if len(set(vals)) != 1:
            fails.append(f"wallpaper padding not equal on all 4 sides: {pad_info}")
        elif vals[0] != 60:
            fails.append(f"wallpaper padding should be a fixed 60px, got {vals[0]}px")

    # ---- 8) Copy is the primary (blue) button and comes first; Download is
    # secondary (white/outlined) and comes second ----
    button_order = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const btns = Array.from(shadow.querySelectorAll('button')).filter((b) =>
            ['复制图片', '下载 PNG', '关闭'].includes(b.textContent.trim())
          );
          return btns.map((b) => ({ text: b.textContent.trim(), bg: getComputedStyle(b).backgroundColor }));
        }"""
    )
    print("8) action button order/style:", button_order)
    labels = [b["text"] for b in button_order]
    if labels != ["复制图片", "下载 PNG", "关闭"]:
        fails.append(f"expected button order [复制图片, 下载 PNG, 关闭], got {labels}")
    elif button_order[0]["bg"] != "rgb(29, 155, 240)":
        fails.append(f"expected 复制图片 to be the primary (blue) button, got background {button_order[0]['bg']!r}")
    elif button_order[1]["bg"] == "rgb(29, 155, 240)":
        fails.append("expected 下载 PNG to be the secondary (non-blue) button now, but it's still blue")

    # ---- 9) theme memory: switch back to 黑色 (steps 6/7 already proved
    # clicking it changes the currently-open modal; step 7 switched to 壁纸
    # afterwards, so re-select 黑色 here to make it the last-saved style),
    # close the modal, reopen via the article button again, and confirm the
    # new modal opens already on 黑色 (both the card's own background and the
    # style selector's selected state) — proves the storage.sync round trip
    # (saveStyle on click -> getSavedStyle on next open) actually works, not
    # just that clicking changes the currently-open modal. ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          btns.find((b) => b.textContent.trim() === '黑色').click();
        }"""
    )
    page.wait_for_timeout(150)
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '关闭');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(150)
    still_open = page.evaluate("() => !!document.getElementById('snapcard-host')")
    page.locator('article:not(#tweet-2col):not(#tweet-long):not(#tweet-3pic) .snapcard-btn').click()
    page.wait_for_timeout(200)
    reopened = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return null;
          const shadow = host.shadowRoot;
          const cardNode = host.__snapcardExportEl;
          const bg = cardNode ? cardNode.style.backgroundColor : null; // .style, not getComputedStyle — see the __snapcardExportEl comment above
          const btns = Array.from(shadow.querySelectorAll('button'));
          const darkBtn = btns.find((b) => b.textContent.trim() === '黑色');
          const darkSelected = darkBtn ? getComputedStyle(darkBtn).backgroundColor === 'rgb(29, 155, 240)' : null;
          return { bg, darkSelected };
        }"""
    )
    print(f"9) modal closed while open={still_open}, reopened state: {reopened}")
    if still_open:
        fails.append("modal host was still present right after clicking 关闭")
    if not reopened:
        fails.append("modal did not reopen after clicking the article button again")
    elif reopened.get("bg") != "rgb(0, 0, 0)":
        fails.append(f"expected reopened card to remember 黑色 (black bg), got {reopened.get('bg')!r}")
    elif not reopened.get("darkSelected"):
        fails.append("expected '黑色' style button to show as selected on reopen")

    # ---- 10) "隐藏互动数据" checkbox hides the stats footer, unchecking restores it ----
    footer_before = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          return !!host.shadowRoot.querySelector('[data-snapcard-role="footer"]');
        }"""
    )
    checked_hide = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cb = Array.from(host.shadowRoot.querySelectorAll('input[type=checkbox]')).find(
            (c) => c.nextSibling && c.nextSibling.textContent === '隐藏互动数据'
          );
          if (!cb) return false;
          cb.click();
          return true;
        }"""
    )
    page.wait_for_timeout(150)
    footer_after_hide = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          return !!host.shadowRoot.querySelector('[data-snapcard-role="footer"]');
        }"""
    )
    # uncheck again to confirm it restores
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cb = Array.from(host.shadowRoot.querySelectorAll('input[type=checkbox]')).find(
            (c) => c.nextSibling && c.nextSibling.textContent === '隐藏互动数据'
          );
          cb.click();
        }"""
    )
    page.wait_for_timeout(150)
    footer_after_restore = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          return !!host.shadowRoot.querySelector('[data-snapcard-role="footer"]');
        }"""
    )
    print(
        f"10) hideStats: found_checkbox={checked_hide}, footer before={footer_before}, "
        f"after check={footer_after_hide}, after uncheck={footer_after_restore}"
    )
    if not checked_hide:
        fails.append("could not find/click the '隐藏互动数据' checkbox")
    if footer_before is not True:
        fails.append("expected stats footer to be present before checking 隐藏互动数据")
    if footer_after_hide is not False:
        fails.append("stats footer still present after checking 隐藏互动数据")
    if footer_after_restore is not True:
        fails.append("stats footer did not come back after unchecking 隐藏互动数据")

    # ---- 10b) "隐藏时间" checkbox removes the date next to the name/badge,
    # unchecking restores it — same pattern as 隐藏互动数据 above. ----
    def shadow_has_date():
        return page.evaluate(
            """() => {
              const host = document.getElementById('snapcard-host');
              return host.shadowRoot.textContent.includes('2026年8月19日');
            }"""
        )

    date_before = shadow_has_date()
    checked_hide_time = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cb = Array.from(host.shadowRoot.querySelectorAll('input[type=checkbox]')).find(
            (c) => c.nextSibling && c.nextSibling.textContent === '隐藏时间'
          );
          if (!cb) return false;
          cb.click();
          return true;
        }"""
    )
    page.wait_for_timeout(150)
    date_after_hide = shadow_has_date()
    # uncheck again to confirm it restores
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cb = Array.from(host.shadowRoot.querySelectorAll('input[type=checkbox]')).find(
            (c) => c.nextSibling && c.nextSibling.textContent === '隐藏时间'
          );
          cb.click();
        }"""
    )
    page.wait_for_timeout(150)
    date_after_restore = shadow_has_date()
    print(
        f"10b) hideTime: found_checkbox={checked_hide_time}, date before={date_before}, "
        f"after check={date_after_hide}, after uncheck={date_after_restore}"
    )
    if not checked_hide_time:
        fails.append("could not find/click the '隐藏时间' checkbox")
    if date_before is not True:
        fails.append("expected '2026年8月19日' to be present before checking 隐藏时间")
    if date_after_hide is not False:
        fails.append("'2026年8月19日' still present after checking 隐藏时间")
    if date_after_restore is not True:
        fails.append("'2026年8月19日' did not come back after unchecking 隐藏时间")

    # ---- 11) background thumbnail row (Wallpaper mode only) is collapsed by
    # default: only the currently-selected thumbnail + the "更多壁纸" toggle
    # are round elements in the DOM (everything else isn't rendered at all
    # until expanded, not just CSS-hidden — that's what makes this count
    # check meaningful rather than racing against a clip). Clicking "更多壁纸"
    # must reveal >= 8 (7 built-ins + upload button); clicking "收起" must
    # collapse back down (after the close animation's grace period). ----
    def get_thumb_count():
        return page.evaluate(
            """() => {
              const host = document.getElementById('snapcard-host');
              const items = Array.from(host.shadowRoot.querySelectorAll('button, label')).filter(
                (el) => el.style.borderRadius === '50%'
              );
              return items.length;
            }"""
        )

    def click_bg_toggle():
        return page.evaluate(
            """() => {
              const host = document.getElementById('snapcard-host');
              const btn = host.shadowRoot.querySelector('[data-snapcard-role="bg-toggle"]');
              if (!btn) return null;
              const label = btn.textContent.trim();
              btn.click();
              return label;
            }"""
        )

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          btns.find((b) => b.textContent.trim() === '壁纸').click();
        }"""
    )
    page.wait_for_timeout(300)
    collapsed_count = get_thumb_count()
    print("11) background thumbnails, collapsed (default) count:", collapsed_count)
    if collapsed_count != 1:
        fails.append(f"expected exactly 1 round thumbnail (only the selected one) while collapsed, got {collapsed_count}")

    toggle_label_before = click_bg_toggle()
    page.wait_for_timeout(100)  # children are appended synchronously on click, no need to wait for the animation
    expanded_count = get_thumb_count()
    print(f"    clicked toggle ({toggle_label_before!r}), expanded count: {expanded_count}")
    if toggle_label_before != "更多壁纸 ▸":
        fails.append(f"expected collapsed toggle button to read '更多壁纸 ▸', got {toggle_label_before!r}")
    if expanded_count < 8:
        fails.append(f"expected >= 8 round items (7 built-in backgrounds + upload button) once expanded, got {expanded_count}")

    toggle_label_after = click_bg_toggle()
    page.wait_for_timeout(350)  # collapse defers removing the children until the close transition would finish
    recollapsed_count = get_thumb_count()
    print(f"    clicked toggle again ({toggle_label_after!r}), re-collapsed count: {recollapsed_count}")
    if toggle_label_after != "收起 ◂":
        fails.append(f"expected expanded toggle button to read '收起 ◂', got {toggle_label_after!r}")
    if recollapsed_count != 1:
        fails.append(f"expected background row to collapse back to 1 round thumbnail, got {recollapsed_count}")

    # ---- 12) switching to bg-graphite.jpg actually loads that real file
    # (naturalWidth 1400 is that image's true pixel width on disk — asserting
    # the exact number, not just >0, proves the *right* file loaded, not just
    # *some* image) ----
    click_bg_toggle()  # expand again so the graphite thumbnail exists
    page.wait_for_timeout(100)
    clicked_graphite = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const items = Array.from(host.shadowRoot.querySelectorAll('button')).filter(
            (el) => el.style.borderRadius === '50%' && el.title === 'Graphite 壁纸'
          );
          if (!items.length) return false;
          items[0].click();
          return true;
        }"""
    )
    page.wait_for_timeout(300)
    graphite_info = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const bg = host.shadowRoot.querySelector('[data-snapcard-role="wallpaper-bg"]');
          return bg ? { naturalWidth: bg.naturalWidth, naturalHeight: bg.naturalHeight } : null;
        }"""
    )
    print(f"12) bg-graphite.jpg clicked={clicked_graphite}, background image: {graphite_info}")
    if not clicked_graphite:
        fails.append("could not find/click the 'Graphite 壁纸' thumbnail")
    elif not graphite_info or graphite_info.get("naturalWidth") != 1400:
        fails.append(f"expected bg-graphite.jpg to load at naturalWidth 1400, got {graphite_info}")

    # ---- 13) custom backgrounds are deletable: inject a fake custom
    # background directly into the storage mock, reopen the modal, select it,
    # confirm it (and only it, not the 7 built-ins) shows a delete badge,
    # delete it, confirm it disappears from the row and — since it was the
    # selected background — the selection falls back to Aurora (the default
    # background since the 2026-08-20 Apple-wallpaper-to-original-gradient
    # swap — see CLAUDE.md fault log). ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '关闭');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(150)
    FAKE_CUSTOM_BG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7"
    page.evaluate(
        """(url) => new Promise((resolve) => chrome.storage.local.set({ customBgs: [url] }, resolve))""",
        FAKE_CUSTOM_BG,
    )
    page.locator('article:not(#tweet-2col):not(#tweet-long):not(#tweet-3pic) .snapcard-btn').click()
    page.wait_for_timeout(400)
    # this modal remembers style=黑色 from step 9 — switch to 壁纸 and expand
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          btns.find((b) => b.textContent.trim() === '壁纸').click();
        }"""
    )
    page.wait_for_timeout(200)
    click_bg_toggle()
    page.wait_for_timeout(100)

    custom_thumb_check = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const thumb = Array.from(shadow.querySelectorAll('button')).find((b) => b.title === '自定义背景 1');
          if (!thumb) return { found: false };
          const wrap = thumb.parentElement;
          const del = wrap.querySelector('[data-snapcard-role="bg-delete"]');
          // built-ins must NOT have a delete badge
          const auroraThumb = Array.from(shadow.querySelectorAll('button')).find((b) => b.title === 'Aurora 壁纸');
          const auroraDel = auroraThumb ? auroraThumb.parentElement.querySelector('[data-snapcard-role="bg-delete"]') : 'missing-thumb';
          thumb.click(); // select the custom background
          return { found: true, hasDeleteBadge: !!del, builtinHasDeleteBadge: !!auroraDel };
        }"""
    )
    page.wait_for_timeout(150)
    print("13) custom background thumbnail check:", custom_thumb_check)
    if not custom_thumb_check.get("found"):
        fails.append("injected custom background thumbnail ('自定义背景 1') not found in expanded row")
    else:
        if not custom_thumb_check.get("hasDeleteBadge"):
            fails.append("custom background thumbnail is missing its delete badge")
        if custom_thumb_check.get("builtinHasDeleteBadge"):
            fails.append("a built-in background (Aurora) unexpectedly has a delete badge")

    bg_selected_before_delete = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const wallpaperBg = host.shadowRoot.querySelector('[data-snapcard-role="wallpaper-bg"]');
          return wallpaperBg ? wallpaperBg.src : null;
        }"""
    )
    deleted = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const thumb = Array.from(shadow.querySelectorAll('button')).find((b) => b.title === '自定义背景 1');
          if (!thumb) return false;
          const del = thumb.parentElement.querySelector('[data-snapcard-role="bg-delete"]');
          if (!del) return false;
          del.click();
          return true;
        }"""
    )
    page.wait_for_timeout(200)
    after_delete = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const stillThere = !!Array.from(shadow.querySelectorAll('button')).find((b) => b.title === '自定义背景 1');
          const wallpaperBg = shadow.querySelector('[data-snapcard-role="wallpaper-bg"]');
          return { stillThere, bgSrc: wallpaperBg ? wallpaperBg.src : null };
        }"""
    )
    print(
        f"    selected before delete: {bg_selected_before_delete[:40] if bg_selected_before_delete else None!r}..., "
        f"deleted={deleted}, after: stillThere={after_delete['stillThere']}, "
        f"bgSrc={after_delete['bgSrc'][-30:] if after_delete['bgSrc'] else None!r}"
    )
    if bg_selected_before_delete != FAKE_CUSTOM_BG:
        fails.append(f"expected the custom background to be selected (wallpaper-bg src) before deleting, got {bg_selected_before_delete!r}")
    if not deleted:
        fails.append("could not find/click the delete badge on the custom background thumbnail")
    elif after_delete["stillThere"]:
        fails.append("custom background thumbnail still present after clicking its delete badge")
    elif not after_delete["bgSrc"] or "bg-aurora" not in after_delete["bgSrc"]:
        fails.append(f"expected selection to fall back to Aurora after deleting the selected custom background, got {after_delete['bgSrc']!r}")

    # ---- 14) two images show FULLY, side by side at equal height (2026-08-20
    # user spec): #tweet-2col's photos have natural sizes 300x600 (ratio 0.5)
    # and 600x600 (ratio 1.0). finalizeMediaLayout must split the two columns
    # proportionally to those natural ratios so both images render complete
    # and the two cells end up the same height. (The 254x460 timeline
    # container ratio is now only the pre-load placeholder.) ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host) return;
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '关闭');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(150)
    mock_ratio = page.evaluate(
        """() => {
          const el = document.querySelector('#tweet-2col [data-testid="tweetPhoto"]');
          const r = el.getBoundingClientRect();
          return r.width / r.height;
        }"""
    )
    page.locator("#tweet-2col .snapcard-btn").click()
    page.wait_for_timeout(500)
    card_ratios = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          // host.__snapcardExportEl is detached (only a *scaled clone* of it
          // is mounted, for the fit-to-view preview) — mount a fresh clone
          // off-screen to get real, unscaled numbers.
          const original = host.__snapcardExportEl;
          if (!original) return null;
          const card = original.cloneNode(true);
          const probe = document.createElement('div');
          Object.assign(probe.style, { position: 'fixed', left: '-9999px', top: '0' });
          probe.appendChild(card);
          document.body.appendChild(probe);
          const cells = Array.from(card.querySelectorAll('div')).filter(
            (d) => d.style.aspectRatio && d.style.position === 'relative'
          );
          const result = cells.map((c) => {
            const r = c.getBoundingClientRect();
            return { ratio: r.width / r.height, height: r.height };
          });
          document.body.removeChild(probe);
          return result;
        }"""
    )
    print(f"14) timeline placeholder ratio: {mock_ratio:.4f}, card 2-up cells: {card_ratios}")
    if not card_ratios or len(card_ratios) != 2:
        fails.append(f"expected exactly 2 media cells in the #tweet-2col card, got {card_ratios}")
    else:
        for i, expected in enumerate((0.5, 1.0)):
            got = card_ratios[i]["ratio"]
            if abs(got - expected) / expected >= 0.02:
                fails.append(
                    f"2-up cell {i} should sit at its image's natural ratio {expected} (full display), got {got:.4f}"
                )
        h1, h2 = card_ratios[0]["height"], card_ratios[1]["height"]
        if abs(h1 - h2) > 1:
            fails.append(f"2-up cells should be equal height, got {h1:.1f} vs {h2:.1f}")

    # ---- 15a) fit-to-view: the #tweet-2col modal (still open from step 14,
    # tall portrait card that needs shrinking) must show the whole card within
    # the ~56vh preview viewport — scaled wrapper height must not exceed it ----
    fit_info = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const viewport = host.shadowRoot.querySelector('[data-snapcard-role="preview-viewport"]');
          const wrapper = host.shadowRoot.querySelector('[data-snapcard-role="preview-scaled-wrapper"]');
          if (!viewport || !wrapper) return null;
          const vr = viewport.getBoundingClientRect();
          const wr = wrapper.getBoundingClientRect();
          return { viewportHeight: vr.height, wrapperHeight: wr.height };
        }"""
    )
    print("15a) fit-to-view (viewport vs scaled wrapper height):", fit_info)
    if not fit_info:
        fails.append("preview viewport / scaled-wrapper not found")
    elif fit_info["wrapperHeight"] > fit_info["viewportHeight"] + 1:  # +1px rounding fuzz
        fails.append(
            f"scaled preview wrapper height {fit_info['wrapperHeight']} exceeds "
            f"viewport height {fit_info['viewportHeight']} — card not fully visible"
        )

    # ---- 15b) click-to-zoom: clicking the scaled preview opens a full-size
    # overlay containing a *clone* of the card; Esc closes just that layer,
    # leaving the modal itself open (not the whole thing) ----
    clicked_preview = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const wrapper = host.shadowRoot.querySelector('[data-snapcard-role="preview-scaled-wrapper"]');
          if (!wrapper) return false;
          wrapper.click();
          return true;
        }"""
    )
    page.wait_for_timeout(150)
    zoom_info = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const overlay = host.shadowRoot.querySelector('[data-snapcard-role="zoom-overlay"]');
          const clone = overlay ? overlay.querySelector('[data-snapcard-role="zoom-clone"]') : null;
          return { overlayFound: !!overlay, cloneFound: !!clone };
        }"""
    )
    print(f"15b) clicked preview={clicked_preview}, zoom overlay: {zoom_info}")
    if not clicked_preview:
        fails.append("could not click the scaled preview wrapper")
    if not zoom_info.get("overlayFound"):
        fails.append("zoom overlay did not appear after clicking the preview")
    if not zoom_info.get("cloneFound"):
        fails.append("zoom overlay is missing the card clone")

    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    after_esc = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          return {
            modalOpen: !!host,
            overlayGone: !host.shadowRoot.querySelector('[data-snapcard-role="zoom-overlay"]'),
          };
        }"""
    )
    print("    after Esc:", after_esc)
    if not after_esc.get("modalOpen"):
        fails.append("Esc while zoomed closed the whole modal, not just the zoom layer")
    if not after_esc.get("overlayGone"):
        fails.append("zoom overlay still present after pressing Esc")

    # ---- 15c) export size is unaffected by the preview's fit-to-view scale:
    # exporting at scale=2 must still produce a 1200px-wide canvas (600px
    # fixed card width x 2), not something shrunk by whatever the preview
    # happened to be scaled to. This modal inherited theme="wallpaper" from
    # earlier steps' shared storage.sync memory (expected behavior — style
    # memory is global, not per-tweet), so switch back to 白色 first to test
    # against a plain 600px card as intended, and to avoid the wallpaper
    # background's known file://-fetch console error (see fault log) from
    # firing during an otherwise-unrelated check. ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '白色');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(150)
    export_size = page.evaluate(
        """async () => {
          const host = document.getElementById('snapcard-host');
          const exportEl = host.__snapcardExportEl;
          if (!exportEl) return null;
          const { canvas } = await window.SnapCard.renderCardToPng(exportEl, 2);
          return { width: canvas.width, height: canvas.height };
        }"""
    )
    print("15c) export canvas size at scale=2:", export_size)
    if not export_size or export_size.get("width") != 1200:
        fails.append(f"expected export canvas width 1200 (600x2, unaffected by preview scale), got {export_size}")

    # ---- 16) English locale: flip the mock's UI language to "en" (no reload
    # needed — content.js/card.js call chrome.i18n.getUILanguage()/getMessage()
    # fresh on every modal open, per the i18n mock comment in mock.html) and
    # reopen the modal. Confirms _locales/en/messages.json actually drives the
    # UI, not just that zh_CN still passes by default. ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (host) {
            const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
            const btn = btns.find((b) => b.textContent.trim() === '关闭' || b.textContent.trim() === 'Close');
            if (btn) btn.click();
          }
        }"""
    )
    page.wait_for_timeout(150)
    page.evaluate("() => { window.__snapcardLocale = 'en'; }")
    page.locator('article:not(#tweet-2col):not(#tweet-long):not(#tweet-3pic) .snapcard-btn').click()
    page.wait_for_timeout(400)

    en_style_labels = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const btns = Array.from(shadow.querySelectorAll('button'));
          return btns.map((b) => b.textContent.trim()).filter((t) => ['White', 'Dark', 'Wallpaper'].includes(t));
        }"""
    )
    en_copy_label = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const btns = Array.from(shadow.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === 'Copy image');
          return btn ? btn.textContent.trim() : null;
        }"""
    )
    print(f"16) en locale: style selector = {en_style_labels}, primary button = {en_copy_label!r}")
    for expected in ("White", "Dark", "Wallpaper"):
        if expected not in en_style_labels:
            fails.append(f"en locale: style selector missing '{expected}' option, got {en_style_labels}")
    if en_copy_label != "Copy image":
        fails.append(f"en locale: expected primary button text 'Copy image', got {en_copy_label!r}")

    # reset back to zh-CN so nothing downstream silently runs against the
    # wrong locale, and reopen a fresh Chinese modal for the next checks
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (host) {
            const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
            const btn = btns.find((b) => ['关闭', 'Close'].includes(b.textContent.trim()));
            if (btn) btn.click();
          }
          window.__snapcardLocale = 'zh-CN';
        }"""
    )
    page.wait_for_timeout(150)
    page.locator('article:not(#tweet-2col):not(#tweet-long):not(#tweet-3pic) .snapcard-btn').click()
    page.wait_for_timeout(400)

    # ---- 17) translated card shows ONLY the translation (no bilingual
    # stack): checking 翻译 must swap the body text to role "text-translated"
    # with the mock translation, with no "text-original" block left; unchecking
    # must restore the original. Checked on __snapcardExportEl (the real
    # about-to-be-exported node — detached, so querySelector works but
    # getComputedStyle would not; see the detached-node fault-log entry). ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const labels = Array.from(host.shadowRoot.querySelectorAll('label'));
          const label = labels.find((l) => l.textContent.trim() === '翻译');
          const cb = label && label.querySelector('input[type="checkbox"]');
          if (cb) cb.click();
        }"""
    )
    page.wait_for_timeout(300)
    translated_state = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const exportEl = host.__snapcardExportEl;
          if (!exportEl) return null;
          const translated = exportEl.querySelector('[data-snapcard-role="text-translated"]');
          return {
            translatedText: translated ? translated.textContent : null,
            originalPresent: !!exportEl.querySelector('[data-snapcard-role="text-original"]'),
          };
        }"""
    )
    print("17) translated-only card:", translated_state)
    if not translated_state or translated_state.get("translatedText") != "模拟翻译结果":
        fails.append(f"expected translated card body to be exactly the mock translation, got {translated_state}")
    if translated_state and translated_state.get("originalPresent"):
        fails.append("original text block still present on a translated card — card must show only the translation")

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const labels = Array.from(host.shadowRoot.querySelectorAll('label'));
          const label = labels.find((l) => l.textContent.trim() === '翻译');
          const cb = label && label.querySelector('input[type="checkbox"]');
          if (cb) cb.click();
        }"""
    )
    page.wait_for_timeout(200)
    untranslated_state = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const exportEl = host.__snapcardExportEl;
          const original = exportEl && exportEl.querySelector('[data-snapcard-role="text-original"]');
          return {
            originalBack: !!original,
            translatedGone: !(exportEl && exportEl.querySelector('[data-snapcard-role="text-translated"]')),
          };
        }"""
    )
    print("    after unchecking 翻译:", untranslated_state)
    if not untranslated_state.get("originalBack") or not untranslated_state.get("translatedGone"):
        fails.append(f"unchecking 翻译 should restore the original-only body, got {untranslated_state}")

    # ---- 18) manual 中/EN UI-language toggle: in a Chinese UI the corner
    # button reads "EN"; clicking it stores uiLang="en" and rebuilds the whole
    # modal in English (even though the browser locale is still zh-CN — this
    # is exactly what distinguishes the manual override from test 16's
    # browser-locale behavior); clicking the (now "中") button switches back. ----
    toggle_label = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btn = host.shadowRoot.querySelector('[data-snapcard-role="lang-toggle"]');
          return btn ? btn.textContent.trim() : null;
        }"""
    )
    print("18) lang toggle label in Chinese UI:", toggle_label)
    if toggle_label != "EN":
        fails.append(f"expected lang toggle to read 'EN' in a Chinese UI, got {toggle_label!r}")

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btn = host.shadowRoot.querySelector('[data-snapcard-role="lang-toggle"]');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(600)  # modal closes and fully reopens (extract + storage reads + locale fetch)
    after_toggle = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return null;
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const toggle = host.shadowRoot.querySelector('[data-snapcard-role="lang-toggle"]');
          return {
            copyLabel: btns.some((b) => b.textContent.trim() === 'Copy image'),
            toggleLabel: toggle ? toggle.textContent.trim() : null,
          };
        }"""
    )
    print("    after clicking EN (browser locale still zh-CN):", after_toggle)
    if not after_toggle or not after_toggle.get("copyLabel"):
        fails.append(f"clicking the EN toggle should rebuild the modal in English, got {after_toggle}")
    if after_toggle and after_toggle.get("toggleLabel") != "中":
        fails.append(f"expected lang toggle to read '中' in an English UI, got {after_toggle}")

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btn = host.shadowRoot.querySelector('[data-snapcard-role="lang-toggle"]');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(600)
    back_to_zh = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return null;
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const toggle = host.shadowRoot.querySelector('[data-snapcard-role="lang-toggle"]');
          return {
            copyLabel: btns.some((b) => b.textContent.trim() === '复制图片'),
            toggleLabel: toggle ? toggle.textContent.trim() : null,
          };
        }"""
    )
    print("    after clicking 中:", back_to_zh)
    if not back_to_zh or not back_to_zh.get("copyLabel") or back_to_zh.get("toggleLabel") != "EN":
        fails.append(f"clicking 中 should rebuild the modal in Chinese with an 'EN' toggle, got {back_to_zh}")

    # ---- 19) long tweet + slow-loading single image (the "long cards get
    # clipped in preview AND zoom" regression). #tweet-long has multi-
    # paragraph text and a photo with NO captured display ratio whose bytes
    # arrive ~400ms late (see the route above). The card must (a) actually
    # contain the image at its real height — export height way beyond the
    # text-only height the buggy early measurement produced — and (b) still
    # fit the 56vh preview viewport; then in Wallpaper mode the frame must
    # wrap the *final* card size with the fixed 60px pad on every side. ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (host) {
            const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
            const btn = btns.find((b) => ['关闭', 'Close'].includes(b.textContent.trim()));
            if (btn) btn.click();
          }
        }"""
    )
    page.wait_for_timeout(150)
    page.locator('#tweet-long .snapcard-btn').click()
    page.wait_for_timeout(2200)  # image delay + decode-wait + rebuild

    long_fit = page.evaluate(
        """async () => {
          const host = document.getElementById('snapcard-host');
          const shadow = host.shadowRoot;
          const viewport = shadow.querySelector('[data-snapcard-role="preview-viewport"]');
          const wrapper = shadow.querySelector('[data-snapcard-role="preview-scaled-wrapper"]');
          const exportEl = host.__snapcardExportEl;
          if (!viewport || !wrapper || !exportEl) return null;
          const probe = document.createElement('div');
          probe.style.cssText = 'position:fixed;left:-9999px;top:0;';
          const clone = exportEl.cloneNode(true);
          probe.appendChild(clone);
          document.body.appendChild(probe);
          await Promise.all(Array.from(clone.querySelectorAll('img')).map((i) => i.decode().catch(() => {})));
          const exportH = clone.getBoundingClientRect().height;
          document.body.removeChild(probe);
          return {
            viewportH: viewport.getBoundingClientRect().height,
            wrapperH: wrapper.getBoundingClientRect().height,
            exportH,
          };
        }"""
    )
    print("19) long tweet fit-to-view:", long_fit)
    if not long_fit or long_fit["exportH"] <= 900:
        fails.append(f"long-tweet card should include the late image (export height > 900), got {long_fit}")
    if long_fit and long_fit["wrapperH"] > long_fit["viewportH"] + 1:
        fails.append(f"long-tweet preview overflows its viewport (was the scale measured before the image loaded?): {long_fit}")

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === '壁纸');
          if (btn) btn.click();
        }"""
    )
    page.wait_for_timeout(1500)
    frame_fit = page.evaluate(
        """async () => {
          const host = document.getElementById('snapcard-host');
          const exportEl = host.__snapcardExportEl;
          if (!exportEl || exportEl.dataset.snapcardRole !== 'wallpaper-frame') return null;
          const probe = document.createElement('div');
          probe.style.cssText = 'position:fixed;left:-9999px;top:0;';
          const clone = exportEl.cloneNode(true);
          probe.appendChild(clone);
          document.body.appendChild(probe);
          await Promise.all(Array.from(clone.querySelectorAll('img')).map((i) => i.decode().catch(() => {})));
          const frameRect = clone.getBoundingClientRect();
          const centerLayer = clone.querySelector('[data-snapcard-role="wallpaper-bg"]').nextElementSibling;
          const cardRect = centerLayer.firstElementChild.getBoundingClientRect();
          document.body.removeChild(probe);
          return {
            frameW: frameRect.width, frameH: frameRect.height,
            cardW: cardRect.width, cardH: cardRect.height,
          };
        }"""
    )
    print("    wallpaper frame vs final card:", frame_fit)
    if not frame_fit or frame_fit["cardH"] <= 900:
        fails.append(f"wallpaper-mode long card should include the late image (card height > 900), got {frame_fit}")
    if frame_fit and (abs(frame_fit["frameH"] - frame_fit["cardH"] - 120) > 2 or abs(frame_fit["frameW"] - frame_fit["cardW"] - 120) > 2):
        fails.append(f"wallpaper frame no longer wraps the final card with 60px pads on all sides: {frame_fit}")

    # ---- 20) opt-in vertical stack for 3+ images: #tweet-3pic (natural
    # ratios 0.5 / 1.0 / 1.333) defaults to the X-style 3-tile grid; checking
    # 图片竖排 must relayout to a full-width vertical stack with every image
    # at its own natural ratio; unchecking restores the grid. ----
    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (host) {
            const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
            const btn = btns.find((b) => ['关闭', 'Close'].includes(b.textContent.trim()));
            if (btn) btn.click();
          }
        }"""
    )
    page.wait_for_timeout(150)
    page.locator('#tweet-3pic .snapcard-btn').click()
    page.wait_for_timeout(500)

    def media_layout():
        return page.evaluate(
            """async () => {
              const host = document.getElementById('snapcard-host');
              const exportEl = host.__snapcardExportEl;
              if (!exportEl) return null;
              const probe = document.createElement('div');
              probe.style.cssText = 'position:fixed;left:-9999px;top:0;';
              const clone = exportEl.cloneNode(true);
              probe.appendChild(clone);
              document.body.appendChild(probe);
              await Promise.all(Array.from(clone.querySelectorAll('img')).map((i) => i.decode().catch(() => {})));
              const wrap = clone.querySelector('[data-snapcard-media]');
              const tiles = wrap
                ? Array.from(wrap.querySelectorAll('div')).filter((d) => d.style.aspectRatio && d.style.position === 'relative')
                : [];
              const rects = tiles.map((t) => {
                const r = t.getBoundingClientRect();
                return { width: r.width, ratio: r.width / r.height };
              });
              document.body.removeChild(probe);
              return { kind: wrap ? wrap.dataset.snapcardMedia : null, tiles: rects };
            }"""
        )

    grid_default = media_layout()
    print("20) 3-image default layout:", grid_default)
    if not grid_default or grid_default["kind"] != "3":
        fails.append(f"3-image tweet should default to the X-style grid (kind '3'), got {grid_default}")

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cb = host.shadowRoot.querySelector('[data-snapcard-role="stack-images-checkbox"]');
          if (cb) cb.click();
        }"""
    )
    page.wait_for_timeout(400)
    stacked = media_layout()
    print("    after checking 图片竖排:", stacked)
    if not stacked or stacked["kind"] != "stack" or len(stacked["tiles"]) != 3:
        fails.append(f"expected a 3-tile vertical stack after checking 图片竖排, got {stacked}")
    else:
        for i, expected in enumerate((0.5, 1.0, 400 / 300)):
            got = stacked["tiles"][i]["ratio"]
            if abs(got - expected) / expected >= 0.02:
                fails.append(f"stacked tile {i} should be at natural ratio {expected:.3f}, got {got:.4f}")
        widths = [t["width"] for t in stacked["tiles"]]
        if max(widths) - min(widths) > 1 or abs(widths[0] - 536) > 2:
            fails.append(f"stacked tiles should all span the card's 536px content width, got {widths}")

    page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const cb = host.shadowRoot.querySelector('[data-snapcard-role="stack-images-checkbox"]');
          if (cb) cb.click();
        }"""
    )
    page.wait_for_timeout(400)
    grid_back = media_layout()
    print("    after unchecking:", {"kind": grid_back and grid_back["kind"]})
    if not grid_back or grid_back["kind"] != "3":
        fails.append(f"unchecking 图片竖排 should restore the X-style grid, got {grid_back}")

if console_errors:
    print("\nconsole errors captured:")
    for e in console_errors:
        print("  -", e)
if page_errors:
    print("\nuncaught page errors captured:")
    for e in page_errors:
        print("  -", e)
if console_errors:
    fails.append(f"{len(console_errors)} console error(s) logged (see above)")
if page_errors:
    fails.append(f"{len(page_errors)} uncaught page error(s) (see above)")

print()
if fails:
    print(f"FAIL ({len(fails)}):")
    for f in fails:
        print("  -", f)
    sys.exit(1)
else:
    print("PASS: all smoke checks passed")
