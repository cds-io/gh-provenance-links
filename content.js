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
