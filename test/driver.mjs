// A browser-driven verification harness for the extension. It loads the unpacked
// extension into a real Chromium, drives it against a live GitHub blob, and answers
// the question that actually matters: not "did we create an anchor?" but "can a
// human click it?" Those come apart here, because GitHub overlays the code with a
// transparent <textarea> that eats clicks (see content.js), so a link can exist in
// the DOM, look perfect, and still be dead. A DOM-existence assertion would pass
// while the feature is broken; only elementFromPoint and a synthetic mouse click
// tell the truth, so that is what this script reports.
//
// With no URL it self-targets: the extension's own content.js on GitHub, whose
// header comment carries `Report: ../foo.md` and `Issue: #213`, so the extension
// linkifies its own source and the test borrows no third-party repo.
//
//   node test/driver.mjs                     self-target content.js, interactive
//   node test/driver.mjs --dump              self-target, print the report and exit
//   node test/driver.mjs <url>               drive a specific blob instead
//   node test/driver.mjs <url> --line 213    scroll line 213 in first (virtualized rows
//                                            mount only on screen); also read from the #L hash
//   node test/driver.mjs <url> --match foo   locate the linkified token by substring
//                                            (default: #213, the self-target's token)
//
// The extension only loads in a *persistent* context, launched headed. We use
// Playwright's bundled Chromium (Chrome for Testing) rather than channel: "chrome":
// system Google Chrome stable (2026) ignores --load-extension outright, so it would
// silently load nothing and every probe would read a false negative.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Self-target: this extension's own content.js, whose header carries the grammar
// (`Issue: #213` on line 3). Used when no URL is passed.
const SELF = "https://github.com/cds-io/gh-provenance-links/blob/master/content.js#L3";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) ?? SELF;
const dump = args.includes("--dump");
const lineFlag = args.indexOf("--line");
const matchFlag = args.indexOf("--match");
// Substring that locates the linkified token (a report path, a URL, an issue ref);
// the anchor probe and the fact-gathering both key off it. The default is the
// self-target's token, so a bare `node test/driver.mjs` is a complete self-test.
const MATCH = matchFlag !== -1 ? args[matchFlag + 1] : "#213";
// Target line: --line wins, else fall back to the URL's own #L<n> anchor.
const hashLine = url && url.match(/#L(\d+)/);
const line = lineFlag !== -1 ? Number(args[lineFlag + 1]) : hashLine ? Number(hashLine[1]) : null;

// "" gives a fresh throwaway profile per run. Swap in a fixed directory to stay
// logged in across runs (needed for private repos).
const context = await chromium.launchPersistentContext("", {
  headless: false, // headed: loads the extension reliably, and lets us watch it work
  viewport: { width: 1400, height: 1000 },
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    // Belt-and-suspenders: Chrome 136+ gated --load-extension behind this feature.
    // Bundled Chromium honors the flag without it, but keeping it costs nothing.
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
  ],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" });

// Scroll the target line into view so the virtualized list mounts its row; only
// then can the content script's MutationObserver see it and linkify it.
if (line != null) {
  const row = page.locator(`#L${line}, [data-line-number="${line}"]`).first();
  await row.scrollIntoViewIfNeeded().catch(() => {}); // best effort; row markup varies
}

// Wait out the content script's 150ms debounce plus GitHub's own async render.
await page.waitForTimeout(800);

const anchors = await page.$$eval("a[data-gh-provenance]", (els) =>
  els.map((e) => ({ text: e.textContent, href: e.href })),
);

console.log(`\nfound ${anchors.length} provenance link(s):`);
for (const a of anchors) console.log(`  ${JSON.stringify(a.text)}  ->  ${a.href}`);
console.log();

// Overlay probe: locate the visible anchor for our token, then ask the two
// questions a DOM-existence check cannot. Whose anchor is it (does it carry
// data-gh-provenance, or did GitHub autolink it)? And what element actually sits at
// its center pixel: if elementFromPoint returns anything but an anchor to the same
// href, a click there is being intercepted.
const probe = await page.evaluate((MATCH) => {
  // Match by visible text or href, and require a real rect so we skip the hidden,
  // zero-size anchors GitHub scatters elsewhere on the page.
  const a = [...document.querySelectorAll("a")].find((e) => {
    if (!(e.href.includes(MATCH) || e.textContent.includes(MATCH))) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!a) return { found: false };
  const r = a.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  // Compact node label: tag#id.class1.class2.
  const desc = (el) =>
    el
      ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${
          el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
            : ""
        }`
      : String(el);
  // Walk up from the topmost element so the report shows the overlay's container.
  const chain = [];
  for (let el = top; el && chain.length < 5; el = el.parentElement) chain.push(desc(el));
  return {
    found: true,
    mine: a.dataset.ghProvenance === "1",
    href: a.href,
    rect: { x, y, w: Math.round(r.width), h: Math.round(r.height) },
    anchorDesc: desc(a),
    topDesc: desc(top),
    // Success: the topmost element at the token's pixel is an anchor to the same
    // href (the inline anchor, or the hover proxy parked over it).
    topIsAnchor: !!(top && top.closest && top.closest("a") && top.closest("a").href === a.href),
    topChain: chain,
    topPointerEvents: top ? getComputedStyle(top).pointerEvents : null,
  };
}, MATCH);

// Facts that hold whether or not an anchor exists, so a zero-link run is still
// diagnosable: did our content script run at all, how is the matched token split
// across text nodes (one node, or fragmented across syntax-token spans?), and does
// GitHub's cursor-overlay textarea sit over it?
const facts = await page.evaluate((MATCH) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const matched = [];
  for (let n; (n = walker.nextNode()); ) {
    if (n.nodeValue && n.nodeValue.includes(MATCH)) {
      matched.push({ text: n.nodeValue.trim().slice(0, 60), parentTag: n.parentElement?.tagName.toLowerCase(), inAnchor: !!n.parentElement?.closest("a") });
    }
  }
  const ta = document.querySelector("textarea#read-only-cursor-text-area, textarea[id*='cursor']");

  // Interception test, independent of our extension: take the VISIBLE rendered text
  // node holding the token (skip the <script> JSON copy and the <textarea> text
  // copy, both of which also contain it) and ask what occupies its center pixel.
  let intercept = null;
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w2.nextNode()); ) {
    if (!n.nodeValue || !n.nodeValue.includes(MATCH)) continue;
    if (n.parentElement?.closest("script, style, textarea")) continue; // not rendered code
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // not laid out / off screen
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    intercept = {
      tokenText: n.nodeValue.trim().slice(0, 40),
      topmost: top ? `${top.tagName.toLowerCase()}${top.id ? "#" + top.id : ""}` : String(top),
    };
    break;
  }

  return {
    ourScriptRan: !!document.querySelector("[data-gh-provenance]"),
    matchedTextNodes: matched,
    overlay: ta ? { id: ta.id, z: getComputedStyle(ta).zIndex, pe: getComputedStyle(ta).pointerEvents } : null,
    intercept,
  };
}, MATCH);
console.log("facts:");
console.log(`  our content script ran (any data-gh-provenance): ${facts.ourScriptRan}`);
console.log(`  text nodes containing "${MATCH}": ${facts.matchedTextNodes.length}`);
for (const n of facts.matchedTextNodes) console.log(`    <${n.parentTag}> inAnchor=${n.inAnchor}  ${JSON.stringify(n.text)}`);
console.log(`  cursor overlay: ${facts.overlay ? JSON.stringify(facts.overlay) : "none found"}`);
if (facts.intercept) {
  console.log(`  at the token's pixel (${JSON.stringify(facts.intercept.tokenText)}), topmost element is: ${facts.intercept.topmost}`);
}
console.log();

console.log("overlay probe:");
if (!probe.found) {
  console.log("  no anchor found for the token in the code area (see facts above).\n");
} else {
  console.log(`  anchor:        ${probe.anchorDesc}  (${probe.mine ? "OURS, data-gh-provenance" : "GitHub's, not ours"})`);
  console.log(`  href:          ${probe.href}`);
  console.log(`  center px:     (${probe.rect.x}, ${probe.rect.y})  size ${probe.rect.w}x${probe.rect.h}`);
  console.log(`  topmost there: ${probe.topDesc}   pointer-events: ${probe.topPointerEvents}`);
  console.log(`  click reaches anchor? ${probe.topIsAnchor ? "YES" : "NO, intercepted"}`);
  console.log(`  stack at point: ${probe.topChain.join("  >  ")}`);

  // The genuine end-to-end check: a synthetic mouse, the way a user drives it, not
  // el.click() (which skips hit-testing and would "pass" against a buried anchor).
  // The hover proxy only appears under a moving cursor, so move first, let the rAF
  // handler park it, confirm it took the top spot, then click. The proxy opens
  // target=_blank, so a hit shows up as a new tab, not a same-tab navigation.
  await page.mouse.move(probe.rect.x, probe.rect.y);
  await page.waitForTimeout(120); // let the rAF-throttled hover handler run
  const afterHover = await page.evaluate(({ x, y, href }) => {
    const top = document.elementFromPoint(x, y);
    const a = top && top.closest && top.closest("a");
    const px = document.getElementById("gh-prov-hover");
    // The full hit stack, tagging our inline anchor [prov] if it appears. It should
    // NOT: GitHub's pointer-events:none keeps it out of hit-testing, which is the
    // whole reason the proxy exists, so anchorInStack:false is the expected result.
    const stack = document.elementsFromPoint(x, y).map((el) =>
      el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.dataset?.ghProvenance ? "[prov]" : ""),
    );
    return {
      topDesc: top ? top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") : String(top),
      reaches: !!(a && a.href === href),
      proxy: px ? { connected: true, display: px.style.display, href: px.href || "(unset)" } : { connected: false },
      stack: stack.slice(0, 6),
      anchorInStack: stack.some((s) => s.includes("[prov]")),
    };
  }, { x: probe.rect.x, y: probe.rect.y, href: probe.href });
  console.log(`  after hover, topmost: ${afterHover.topDesc}   reaches anchor? ${afterHover.reaches ? "YES" : "NO"}`);
  console.log(`    proxy: ${JSON.stringify(afterHover.proxy)}`);
  console.log(`    hit stack: ${afterHover.stack.join("  >  ")}`);
  console.log(`    inline anchor present in stack? ${afterHover.anchorInStack}`);

  // A real new tab is the unambiguous signal that the click landed and navigated;
  // fall back to a same-tab URL change in case a future build drops target=_blank.
  let navigated = false;
  const urlBefore = page.url();
  context.once("page", () => (navigated = true));
  await page.mouse.click(probe.rect.x, probe.rect.y);
  await page.waitForTimeout(700);
  if (!navigated && page.url() !== urlBefore) navigated = true;
  console.log(`  real mouse click navigates? ${navigated ? "YES" : "NO"}`);
}
console.log();

if (dump) {
  await context.close();
} else {
  console.log("Inspector open. Poke at the DOM; resume/▶ to finish.\n");
  await page.pause(); // Playwright Inspector, for interactive exploration
  await context.close();
}
