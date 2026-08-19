#!/usr/bin/env python3
# SnapCard smoke test: mock page + mock chrome API, playwright headless.
# No login, no real x.com — verifies:
#   1) the "Generate card" button gets injected into the tweet's action bar
#   2) clicking it opens the preview modal (shadow DOM) with the card's name text
#   3) clicking "Download PNG" runs the full render pipeline without a JS error
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

    # ---- 3) click Download PNG, expect no JS error ----
    clicked = page.evaluate(
        """() => {
          const host = document.getElementById('snapcard-host');
          if (!host || !host.shadowRoot) return false;
          const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent.trim() === 'Download PNG');
          if (!btn) return false;
          btn.click();
          return true;
        }"""
    )
    print("3) Download PNG button clicked:", clicked)
    if not clicked:
        fails.append("Download PNG button not found in modal")
    else:
        # rendering is async (image inlining + canvas); give it time to finish
        page.wait_for_timeout(1500)
        label = page.evaluate(
            """() => {
              const host = document.getElementById('snapcard-host');
              const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
              const btn = btns.find((b) => b.textContent.trim().startsWith('Download') || b.textContent.trim() === 'Render failed');
              return btn ? btn.textContent.trim() : null;
            }"""
        )
        print("   post-render button label:", label)
        if label == "Render failed":
            fails.append("Download PNG render pipeline reported failure")

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
          return btns.map((b) => b.textContent.trim()).filter((t) => ['White', 'Dark', 'Wallpaper'].includes(t));
        }"""
    )
    print("5) style selector options found:", style_labels)
    for expected in ("White", "Dark", "Wallpaper"):
        if expected not in style_labels:
            fails.append(f"style selector missing '{expected}' option")

    # ---- 6) switching to Dark actually changes the card's background color ----
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
          const btn = btns.find((b) => b.textContent.trim() === 'Dark');
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
    print(f"6) Dark clicked={clicked_dark}, background {bg_before!r} -> {bg_after!r}")
    if not clicked_dark:
        fails.append("could not click the 'Dark' style button")
    elif bg_after != "rgb(0, 0, 0)":
        fails.append(f"expected card background rgb(0, 0, 0) after switching to Dark, got {bg_after!r}")
    elif bg_before == bg_after:
        fails.append("card background did not change when switching from White to Dark")

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
