// GitHub renders Markdown and autolinks URLs in .md files, issues, and PRs, but
// shows source-file blobs as plain syntax-highlighted text: a provenance comment
// like `// Report: ../foo.md` or `// Issue: #213` never becomes a link. This
// content script supplies that linkification, resolving repo-relative paths and
// issue/PR refs against the repo and ref taken from the page URL, so the same
// comment resolves correctly on any fork, branch, or commit.

(function () {
  "use strict";

  // owner / repo / ref / directory of the file currently being viewed, from
  // `/owner/repo/blob/<ref>/<path>`. Null off a blob page (the path grammar
  // needs a file to resolve against; bare URLs still linkify everywhere).
  function pageContext() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)$/);
    if (!m) return null;
    const path = decodeURIComponent(m[4]);
    return {
      owner: m[1],
      repo: m[2],
      ref: m[3],
      dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    };
  }

  // Resolve a path relative to the viewed file's directory (URL `../` semantics).
  function resolvePath(ctx, rel) {
    const stack = ctx.dir ? ctx.dir.split("/") : [];
    for (const part of rel.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.ref}/${stack.join("/")}`;
  }

  // The provenance grammar. Returns non-overlapping {index, length, href} spans
  // over `text`, earliest first.
  function spans(ctx, text) {
    const hits = [];

    const bareUrl = /https?:\/\/[^\s)>\]"'`]+/g;
    for (let m; (m = bareUrl.exec(text)); ) {
      hits.push({ index: m.index, length: m[0].length, href: m[0] });
    }

    if (ctx) {
      // `Report:` / `Doc:` / `Spec:` / `Test:` / `See:` followed by a path that
      // carries a file extension (the extension is what tells a path from prose).
      const pathRef = /(?:Report|Doc|Spec|Test|See):\s+(\S+\.\w+)/g;
      for (let m; (m = pathRef.exec(text)); ) {
        const token = m[1];
        if (/^https?:/.test(token)) continue; // a URL, already covered above
        const index = m.index + m[0].lastIndexOf(token);
        hits.push({ index, length: token.length, href: resolvePath(ctx, token) });
      }

      // `Issue:` / `PR:` and an optional cross-repo `owner/repo` before `#N`.
      const refNum = /(Issue|PR):\s+([\w.-]+\/[\w.-]+)?#(\d+)/g;
      for (let m; (m = refNum.exec(text)); ) {
        const kind = m[1] === "PR" ? "pull" : "issues";
        const repo = m[2] || `${ctx.owner}/${ctx.repo}`;
        const token = (m[2] ? m[2] : "") + "#" + m[3];
        const index = m.index + m[0].indexOf(token);
        hits.push({ index, length: token.length, href: `https://github.com/${repo}/${kind}/${m[3]}` });
      }
    }

    // The three grammars run independently and can claim overlapping text (a bare
    // URL sitting inside a `Report:` value, say), but a link nested in a link is
    // nonsense. Sort earliest-first and keep a hit only when it starts past the end
    // of the last one we took; overlapping latecomers are dropped.
    hits.sort((a, b) => a.index - b.index);
    const out = [];
    let consumedTo = -1;
    for (const h of hits) {
      if (h.index >= consumedTo) {
        out.push(h);
        consumedTo = h.index + h.length;
      }
    }
    return out;
  }

  // Replace a text node with its linkified fragment.
  function linkifyTextNode(node, ctx) {
    const text = node.nodeValue;
    const found = spans(ctx, text);
    if (!found.length) return;

    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const s of found) {
      if (s.index > pos) frag.appendChild(document.createTextNode(text.slice(pos, s.index)));
      const a = document.createElement("a");
      a.href = s.href;
      a.textContent = text.slice(s.index, s.index + s.length);
      a.target = "_blank";
      a.rel = "noopener";
      a.style.textDecoration = "underline";
      // This inline anchor is the visible link and the accessibility target; the
      // click itself is handled by the hover proxy further down, because GitHub's
      // overlay textarea would otherwise eat it. The marker does double duty: the
      // re-scan skips marked anchors (idempotency) and the proxy locates them by it.
      a.dataset.ghProvenance = "1";
      frag.appendChild(a);
      pos = s.index + s.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }

  function scan(ctx) {
    // A comment is usually one highlighted span, so the whole provenance line
    // lives in a single text node. Skip nodes already inside a link.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.length < 5) return NodeFilter.FILTER_REJECT;
        const parent = n.parentElement;
        if (!parent || parent.closest("a, textarea")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    for (let n; (n = walker.nextNode()); ) nodes.push(n);
    for (const n of nodes) linkifyTextNode(n, ctx);
  }

  // The anchors above are visible but, by default, dead. GitHub paints a blob
  // twice: the syntax-highlighted text we just rewrote, and a transparent
  // `<textarea id="read-only-cursor-text-area">` laid over the whole thing,
  // holding a plain-text copy of the file, which is what actually drives
  // selection and the keyboard caret. The textarea wins every click; our anchors
  // sit in the layer beneath it and never see one.
  //
  // It gets worse: the text layer is `pointer-events: none` (so the textarea can
  // own all interaction), which makes our anchors invisible to elementFromPoint /
  // elementsFromPoint. You cannot find them by hit-testing, only by geometry, so
  // the obvious "what is under the cursor?" lookup is out; setting the anchor's
  // own pointer-events back to auto does not rescue it either.
  //
  // The workaround is one reusable proxy anchor that the pointer drags around: on
  // mousemove we geometrically hit-test the cursor against the anchors' rects, and
  // over a token we park the proxy on top of it so the click lands there instead.
  // The proxy lives directly under <body> at the maximum z-index, which is what
  // lets it win: a textarea buried at z-index:1 inside GitHub's tree cannot beat a
  // root-level sibling at 2^31-1. One element repositioned on demand beats a
  // permanent clickable copy of every token, with nothing to keep aligned as the
  // virtualized list scrolls and reflows.
  //
  // Trade-off, stated plainly: while you hover a token the proxy covers it, so you
  // cannot drag-select that token's text. The proxy is also mouse-only (aria-hidden
  // and untabbable); keyboard users get the inline anchor, which the textarea may
  // or may not let them reach. Both are acceptable for links in code comments.
  const proxy = document.createElement("a");
  proxy.id = "gh-prov-hover";
  proxy.target = "_blank";
  proxy.rel = "noopener";
  proxy.setAttribute("aria-hidden", "true");
  proxy.tabIndex = -1;
  proxy.style.cssText =
    "position:fixed;z-index:2147483647;display:none;cursor:pointer;";

  // SPA navigation and React re-renders can wipe <body> out from under us, taking
  // the proxy with it; re-attach lazily rather than assume it stays put.
  function placeProxy() {
    if (document.body && !proxy.isConnected) document.body.appendChild(proxy);
  }

  // A token can wrap across visual lines, so getClientRects returns one rect per
  // line; return the line the cursor is actually in, so the proxy covers that line
  // and not the token's full (multi-line) bounding box.
  function rectUnder(anchor, x, y) {
    for (const r of anchor.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return r;
    }
    return null;
  }

  // Coalesce a mousemove burst into one positioning pass per frame.
  let moveQueued = false;
  let lastX = 0, lastY = 0;
  function onMove(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      placeProxy();
      // Re-query every frame instead of caching: the token count is tiny, and the
      // virtualized list moves rects around constantly, so a cache would just go
      // stale. First anchor under the cursor wins.
      let href = null, rect = null;
      for (const a of document.querySelectorAll("a[data-gh-provenance]")) {
        const r = rectUnder(a, lastX, lastY);
        if (r) { href = a.href; rect = r; break; }
      }
      if (rect) {
        proxy.href = href;
        proxy.style.left = rect.left + "px";
        proxy.style.top = rect.top + "px";
        proxy.style.width = rect.width + "px";
        proxy.style.height = rect.height + "px";
        proxy.style.display = "";
      } else if (proxy.style.display !== "none") {
        proxy.style.display = "none";
      }
    });
  }
  // Capture phase, so we still see the move even if a GitHub handler on the
  // textarea stops it bubbling; passive, because we never call preventDefault.
  addEventListener("mousemove", onMove, { passive: true, capture: true });

  // GitHub's code viewer is a virtualized React list and navigation is SPA-style,
  // so rows mount and remount as you scroll. Re-scan on a debounce; the
  // already-linkified anchors are skipped, so re-scanning is idempotent.
  let pending;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(() => scan(pageContext()), 150);
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
