# GitHub Provenance Links

GitHub renders Markdown and autolinks URLs in `.md` files, issues, and PRs, but
shows source-file blobs as plain syntax-highlighted text. A provenance comment
in your code never becomes a link:

```rust
// Report: ../report/transfer-rejects-fake-asset-owned-by-different-program.md
// Issue: #213
// PR: cds-rs/anchor-litesvm#42
```

This extension makes those clickable in the source view, resolving the targets
against the repository and ref taken from the page URL (so the same comment works
on any fork, branch, or commit).

## Grammar

| In a code comment | Becomes a link to |
|---|---|
| `Report:` / `Doc:` / `Spec:` / `Test:` / `See:` `<path.ext>` | the file's blob, resolved relative to the file you're viewing (`../report/x.md`, `./notes.md`, ...) |
| `Issue: #N` | this repo's issue N |
| `Issue: owner/repo#N` | that repo's issue N |
| `PR: #N` / `PR: owner/repo#N` | the pull request |
| any bare `https://...` | itself (GitHub won't autolink URLs in code; this does) |

A `Report:`/`Doc:`/etc. target is recognized only when it carries a file
extension, which is what distinguishes a path from prose. Paths are resolved with
ordinary relative-path (`../`) semantics from the directory of the file you're
looking at, so write the path as it would be from the source file, not from the
repo root.

## Install (load unpacked)

1. `chrome://extensions` (or `edge://extensions`), enable **Developer mode**.
2. **Load unpacked**, select this directory.
3. Open any source file on github.com; provenance comments are now links.

Firefox: `about:debugging` -> **This Firefox** -> **Load Temporary Add-on**,
pick `manifest.json`.

## How it works

`content.js` runs on `github.com/*`. It reads `owner/repo/ref/path` from the
`/owner/repo/blob/<ref>/<path>` URL, walks the text nodes of the page, and
rewrites matched provenance tokens into anchors. GitHub's code viewer is a
virtualized React list (rows mount as you scroll, navigation is SPA-style), so a
debounced `MutationObserver` re-scans on change; already-linkified anchors are
skipped, so re-scanning is idempotent.

## Scope and limits

- The path grammar needs a blob page (`.../blob/<ref>/...`) to resolve against;
  bare URLs linkify anywhere.
- It does not (yet) handle line anchors in the target (`#L20`) or GitHub's
  permalink-pinned diffs.
- Tuned for the current GitHub code viewer DOM; a future redesign may need the
  selectors revisited (the text-node walk is deliberately structure-agnostic to
  reduce that risk).
