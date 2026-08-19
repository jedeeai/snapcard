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

    # ---- 1) button injected ----
    btn_count = page.locator("article .snapcard-btn").count()
    print("1) buttons injected in article:", btn_count)
    if btn_count != 1:
        fails.append(f"expected exactly 1 .snapcard-btn in article, got {btn_count}")

    # ---- 2) click opens modal, shadow DOM contains card with name text ----
    page.locator("article .snapcard-btn").click()
    page.wait_for_timeout(200)

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
    page.locator("article .snapcard-btn").click()
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
