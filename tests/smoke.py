#!/usr/bin/env python3
# SnapCard smoke test: mock page + mock chrome API, playwright headless.
# UI is Simplified Chinese, so this test matches on the actual on-screen
# button text (下载 PNG, 黑色, 壁纸, ...) rather than English labels.
# No login, no real x.com — verifies:
#   1) the "生成卡片" button gets injected into the tweet's action bar
#   2) clicking it opens the preview modal (shadow DOM) with the card's name text
#   3) clicking "下载 PNG" runs the full render pipeline without a JS error
import os
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK = "file://" + os.path.join(ROOT, "tests", "mock.html")

fails = []
console_errors = []
page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()

    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("download", lambda d: None)  # avoid hanging on the data: URL download

    page.goto(MOCK)
    page.wait_for_timeout(200)

    # ---- 1) button injected (mock.html has 2 articles — the main mock
    # tweet, and #tweet-2col used only by the media-aspect-ratio test) ----
    btn_count = page.locator("article .snapcard-btn").count()
    print("1) buttons injected across articles:", btn_count)
    if btn_count != 2:
        fails.append(f"expected exactly 2 .snapcard-btn (one per mock article), got {btn_count}")

    # ---- 2) click opens modal; a loading spinner shows immediately (before
    # extraction/settings-read finishes), then the card replaces it. Checked
    # with zero wait right after .click() — Playwright's click() only returns
    # once the browser has dispatched and processed the event, i.e. after the
    # click handler's synchronous portion (through its first await) has run,
    # so the spinner must already be in the DOM at this point if the "open
    # modal immediately, build the card asynchronously" behavior is real.
    # (Scoped to the main mock tweet, not #tweet-2col.) ----
    page.locator('article:not(#tweet-2col) .snapcard-btn').click()
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
        print("   name/handle found in shadow text: OK")

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
          const shadow = host.shadowRoot;
          const cardNode = shadow.querySelector('[style*="width: 600px"]');
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
          const cardNode = host.shadowRoot.querySelector('[style*="width: 600px"]');
          return cardNode ? getComputedStyle(cardNode).backgroundColor : null;
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
          const cardNode = host.shadowRoot.querySelector('[style*="width: 600px"]');
          return cardNode ? getComputedStyle(cardNode).backgroundColor : null;
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
    # (mock's chrome.runtime.getURL resolves to the real assets/bg-sequoia.webp
    # on disk — a previous mock stood in a synthetic 1x1 data: URI instead,
    # which is why an earlier screenshot review showed a blank white frame;
    # naturalWidth > 0 here proves the real file decoded successfully in the
    # live preview, which is what that screenshot was checking.)
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
          const frame = host.shadowRoot.querySelector('[data-snapcard-role="wallpaper-frame"]');
          const card = frame ? frame.querySelector('[style*="width: 600px"]') : null;
          if (!frame || !card) return null;
          const f = frame.getBoundingClientRect();
          const c = card.getBoundingClientRect();
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
    page.locator('article:not(#tweet-2col) .snapcard-btn').click()
    page.wait_for_timeout(200)
    reopened = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return null;
          const shadow = host.shadowRoot;
          const cardNode = shadow.querySelector('[style*="width: 600px"]');
          const bg = cardNode ? getComputedStyle(cardNode).backgroundColor : null;
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

    # ---- 12) switching to bg-gradient-dark actually loads that real file
    # (naturalWidth 700 is that image's true pixel width on disk — asserting
    # the exact number, not just >0, proves the *right* file loaded, not just
    # *some* image) ----
    click_bg_toggle()  # expand again so the gradient-dark thumbnail exists
    page.wait_for_timeout(100)
    clicked_gradient_dark = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const items = Array.from(host.shadowRoot.querySelectorAll('button')).filter(
            (el) => el.style.borderRadius === '50%' && el.title === 'Gradient Dark 壁纸'
          );
          if (!items.length) return false;
          items[0].click();
          return true;
        }"""
    )
    page.wait_for_timeout(300)
    gradient_dark_info = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          const bg = host.shadowRoot.querySelector('[data-snapcard-role="wallpaper-bg"]');
          return bg ? { naturalWidth: bg.naturalWidth, naturalHeight: bg.naturalHeight } : null;
        }"""
    )
    print(f"12) bg-gradient-dark clicked={clicked_gradient_dark}, background image: {gradient_dark_info}")
    if not clicked_gradient_dark:
        fails.append("could not find/click the 'Gradient Dark 壁纸' thumbnail")
    elif not gradient_dark_info or gradient_dark_info.get("naturalWidth") != 700:
        fails.append(f"expected bg-gradient-dark.webp to load at naturalWidth 700, got {gradient_dark_info}")

    # ---- 13) custom backgrounds are deletable: inject a fake custom
    # background directly into the storage mock, reopen the modal, select it,
    # confirm it (and only it, not the 7 built-ins) shows a delete badge,
    # delete it, confirm it disappears from the row and — since it was the
    # selected background — the selection falls back to Sequoia. ----
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
    page.locator('article:not(#tweet-2col) .snapcard-btn').click()
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
          const sequoiaThumb = Array.from(shadow.querySelectorAll('button')).find((b) => b.title === 'Sequoia 壁纸');
          const sequoiaDel = sequoiaThumb ? sequoiaThumb.parentElement.querySelector('[data-snapcard-role="bg-delete"]') : 'missing-thumb';
          thumb.click(); // select the custom background
          return { found: true, hasDeleteBadge: !!del, builtinHasDeleteBadge: !!sequoiaDel };
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
            fails.append("a built-in background (Sequoia) unexpectedly has a delete badge")

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
    elif not after_delete["bgSrc"] or "bg-sequoia" not in after_delete["bgSrc"]:
        fails.append(f"expected selection to fall back to Sequoia after deleting the selected custom background, got {after_delete['bgSrc']!r}")

    # ---- 14) media grid mirrors X's own displayed aspect ratio: the second
    # mock tweet (#tweet-2col) has two tweetPhoto containers explicitly sized
    # 254x460 (a tall portrait ratio, like X shows a pair of portrait
    # screenshots) — the card's grid cells must end up the same shape, not
    # force-cropped to some generic fixed ratio. ----
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
          const shadow = host.shadowRoot;
          const card = shadow.querySelector('[style*="width: 600px"]');
          if (!card) return null;
          const cells = Array.from(card.querySelectorAll('div')).filter(
            (d) => d.style.aspectRatio && d.style.position === 'relative'
          );
          return cells.map((c) => {
            const r = c.getBoundingClientRect();
            return r.width / r.height;
          });
        }"""
    )
    print(f"14) mock timeline container ratio: {mock_ratio:.4f}, card grid cell ratios: {card_ratios}")
    if not card_ratios:
        fails.append("could not find media grid cells (style.aspectRatio + position:relative) in the #tweet-2col card")
    else:
        for i, cell_ratio in enumerate(card_ratios):
            diff = abs(cell_ratio - mock_ratio) / mock_ratio
            if diff >= 0.05:
                fails.append(
                    f"card grid cell {i} aspect ratio {cell_ratio:.4f} differs from mock timeline "
                    f"container ratio {mock_ratio:.4f} by {diff:.1%} (must be < 5%)"
                )

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
