// LinkedIn Unbullshitter — content script.
//
// Finds feed posts, extracts their text, and swaps in a "no bullshit" summary.
//
// DOM notes (LinkedIn 2026 server-driven UI):
//   * There is no `data-urn` on feed posts any more. Posts are
//     `[role="listitem"][componentkey^="update-card-focus"]` and the componentkey
//     suffix is a random per-render token, so it can't be a cache key.
//   * Post text lives in `span[data-testid="expandable-text-box"]`. Its parent
//     `<p>` is the commentary container we hide and replace.
//   * Class names are obfuscated (`ebu*`), so class-based selectors only work on
//     the legacy surfaces. data-testid / role are the durable hooks.
//
// Because there is no stable post id, the cache is keyed by a hash of the post
// text: same post in, same summary out, no re-billing on scroll or reload.

(() => {
  "use strict";

  const MIN_CHARS = 30; // below this there is nothing worth summarizing
  const MAX_CONCURRENT = 2; // simultaneous Gemini requests
  const SCAN_DEBOUNCE_MS = 400;
  const CACHE_MAX_ENTRIES = 800;
  const VIEWPORT_MARGIN = "400px 0px"; // start slightly before a post scrolls in

  // First selector that matches anything on the page wins, so we don't mix the
  // SDUI text box with a legacy wrapper and summarize the same post twice.
  const TEXT_SELECTORS = [
    '[data-testid="expandable-text-box"]', // 2026 SDUI
    ".update-components-text",
    '[data-test-id="main-feed-activity-card__commentary"]',
    ".feed-shared-update-v2__description",
    ".feed-shared-inline-show-more-text",
    ".feed-shared-text",
    ".update-components-update-v2__commentary",
    ".attributed-text-segment-list__content",
    '[class*="update-components-text"]',
  ];

  const SEE_MORE_SELECTORS = [
    '[data-testid="expandable-text-button"]',
    ".feed-shared-inline-show-more-text__button",
  ];

  const POST_ROOT_SELECTORS =
    '[role="listitem"], .feed-shared-update-v2, [data-urn^="urn:li:activity"], [data-urn^="urn:li:share"]';

  // Semantic hooks that name a comment/reply subtree. Class names are obfuscated
  // in the 2026 DOM, but componentkey / data-testid still carry meaning.
  const COMMENT_ATTRS = ["componentkey", "data-testid", "data-test-id", "id", "aria-label", "class"];
  const COMMENT_RE = /comment/i;

  const KIND_LABELS = {
    insight: "insight",
    story: "story",
    announcement: "announcement",
    hiring: "hiring",
    promo: "promo",
    engagement_bait: "engagement bait",
    news: "news",
    question: "question",
    other: "post",
  };

  const SUBSTANCE_LABELS = {
    high: "high substance",
    medium: "some substance",
    low: "low substance",
    none: "no substance",
    unknown: "unrated",
  };

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let settings = { enabled: true, debug: true };
  let enabled = true;
  let blocked = false; // true once we learn there is no API key
  let observer = null;
  let viewport = null;
  let scanTimer = null;

  const cache = new Map(); // key -> { summary, substance, kind }
  const queue = [];
  let active = 0;
  let cacheDirty = false;
  let persistTimer = null;

  const diag = {
    postsInDom: 0,
    commentsSkipped: 0,
    watched: 0,
    summarized: 0,
    fromCache: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
    lastKey: null,
    lastTextLen: 0,
  };

  function log(...args) {
    if (settings.debug) {
      console.log("%c[UB]", "color:#0a66c2;font-weight:700", ...args);
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  init();

  // A closed tab or a navigation shouldn't throw away cached summaries.
  window.addEventListener("pagehide", flushCache);

  async function init() {
    try {
      const data = await chrome.storage.local.get({
        ub_settings: { enabled: true, debug: true },
        ub_cache: {},
      });

      settings = { enabled: true, debug: true, ...(data.ub_settings || {}) };
      enabled = settings.enabled !== false;
      blocked = false;

      for (const [key, value] of Object.entries(data.ub_cache || {})) {
        cache.set(key, value);
      }

      log("booted", { enabled, debug: settings.debug, cachedPosts: cache.size, url: location.pathname });
      if (enabled) start();
    } catch (err) {
      console.error("[UB] failed to initialize", err);
    }
  }

  // The popup asks for this over chrome.tabs.sendMessage.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "diagnostics") {
      sendResponse(snapshot());
      return true;
    }
    return false;
  });

  function snapshot() {
    return {
      ok: true,
      url: location.href,
      enabled,
      blocked,
      cachedPosts: cache.size,
      queue: queue.length,
      active,
      diag: { ...diag },
    };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.ub_settings) return;

    const next = changes.ub_settings.newValue || {};
    const wasEnabled = enabled;

    settings = { enabled: true, debug: true, ...next };
    enabled = settings.enabled !== false;
    blocked = false; // settings changed, give it another chance

    if (enabled && !wasEnabled) start();
    if (!enabled && wasEnabled) stop();
    if (enabled && wasEnabled) scheduleScan();
  });

  function start() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", start, { once: true });
      return;
    }

    if (!viewport) {
      viewport = new IntersectionObserver(onIntersect, {
        root: null,
        rootMargin: VIEWPORT_MARGIN,
        threshold: 0,
      });
    }

    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
    }

    scan();
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (viewport) {
      viewport.disconnect();
      viewport = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    queue.length = 0;

    document.querySelectorAll(".ub-summary").forEach((box) => box.remove());
    document
      .querySelectorAll("[data-ub-hidden]")
      .forEach((el) => el.removeAttribute("data-ub-hidden"));
    document.querySelectorAll("[data-ub-state]").forEach((el) => el.removeAttribute("data-ub-state"));
    document
      .querySelectorAll("[data-ub-watched]")
      .forEach((el) => el.removeAttribute("data-ub-watched"));
    document
      .querySelectorAll("[data-ub-host]")
      .forEach((el) => el.removeAttribute("data-ub-host"));

    log("stopped — originals restored");
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  // Registers newly-seen posts with the viewport observer. Nothing is summarized
  // here — that only happens once the post actually approaches the screen.
  function scan() {
    if (!enabled) return;

    selfHeal();

    const anchors = findAnchors();

    let posts = 0;
    let comments = 0;
    let registered = 0;

    for (const anchor of anchors) {
      if (!isPostBody(anchor)) {
        comments++;
        anchor.dataset.ubWatched = "1"; // never reconsider it
        continue;
      }

      posts++;
      if (anchor.dataset.ubWatched) continue;
      anchor.dataset.ubWatched = "1";
      viewport.observe(anchor);
      registered++;
    }

    diag.postsInDom = posts;
    diag.commentsSkipped = comments;

    if (registered) {
      diag.watched += registered;
      log(`registered ${registered} new post(s) — ${posts} posts, ${comments} comments skipped`);
    }
  }

  // If LinkedIn re-rendered a post and dropped our card, re-arm it so the cached
  // summary is mounted again. Cheap, and no API call — the cache is keyed by text.
  function selfHeal() {
    for (const anchor of document.querySelectorAll('[data-ub-watched][data-ub-state="done"]')) {
      const host = anchor.parentElement;
      const hasBox = host && [...host.children].some((c) => c.classList.contains("ub-summary"));
      if (!hasBox) {
        delete anchor.dataset.ubWatched;
        delete anchor.dataset.ubState;
      }
    }
  }

  function findAnchors() {
    for (const selector of TEXT_SELECTORS) {
      const found = document.querySelectorAll(selector);
      if (found.length) return [...found];
    }
    return [];
  }

  // A card can legitimately hold two text boxes — a repost carries the new
  // commentary plus the reshared original — so "first box only" is wrong. What we
  // exclude is comments, which show up either as listitems nested inside the
  // post's listitem or under a subtree whose hooks name comments.
  function isPostBody(anchor) {
    const item = anchor.closest(POST_ROOT_SELECTORS);
    if (!item) return false;

    // Comments/replies are listitems nested inside a post's listitem.
    if (item.parentElement && item.parentElement.closest('[role="listitem"]')) return false;

    // Semantic hooks that name a comment subtree.
    for (let el = anchor; el && el !== item; el = el.parentElement) {
      if (hasCommentMarker(el)) return false;
    }

    return true;
  }

  function hasCommentMarker(el) {
    for (const name of COMMENT_ATTRS) {
      const value = el.getAttribute?.(name);
      if (value && COMMENT_RE.test(value)) return true;
    }
    return false;
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const anchor = entry.target;
      viewport.unobserve(anchor); // handled once
      handleAnchor(anchor);
    }
  }

  // -------------------------------------------------------------------------
  // Summarize / render
  // -------------------------------------------------------------------------

  function handleAnchor(anchor) {
    if (!enabled || anchor.dataset.ubState) return;

    const text = cleanText(anchor.innerText || anchor.textContent || "");

    if (text.length < MIN_CHARS) {
      anchor.dataset.ubState = "skipped";
      diag.skipped++;
      log("text too short, skipping", text.length, "chars");
      return;
    }

    const postRoot = anchor.closest(POST_ROOT_SELECTORS);
    const mount = planMount(anchor);
    if (!mount) {
      anchor.dataset.ubState = "skipped";
      diag.skipped++;
      return;
    }

    const refs = {
      key: cacheKeyFor(text, postRoot),
      anchor,
      box: null,
      host: mount.host,
      original: mount.original,
      insertBefore: mount.insertBefore,
      seeMore: findSeeMore(postRoot),
    };

    claimHost(refs);
    diag.lastKey = refs.key;
    diag.lastTextLen = text.length;

    if (cache.has(refs.key)) {
      renderResult(refs, cache.get(refs.key));
      anchor.dataset.ubState = "done";
      diag.fromCache++;
      diag.summarized++;
      log("served from cache", refs.key);
      return;
    }

    anchor.dataset.ubState = "queued";
    renderLoading(refs);
    log("queued", refs.key, text.length, "chars");

    if (blocked) return;

    queue.push({ refs, text });
    pump();
  }

  // Where to put the summary, and what to hide.
  //
  // In the 2026 SDUI DOM the commentary is a <p> whose only child is the text
  // box. That <p> is a known-good renderer, so we mount inside it and hide the
  // text box — we never remove a layout participant or add a sibling, both of
  // which can collapse a card whose CSS we can't see.
  //
  // For legacy markup the text element is the anchor itself, so we attach beside it.
  function planMount(anchor) {
    const parent = anchor.parentElement;
    if (!parent) return null;
    if (parent.tagName === "P" && parent.children.length === 1) {
      return { host: parent, original: anchor, insertBefore: null };
    }
    return { host: parent, original: anchor, insertBefore: anchor };
  }

  // Taking over the container's layout means clamping, fixed heights, or flex/grid
  // sizing on the commentary can't collapse our card.
  function claimHost(refs) {
    if (refs.insertBefore) return; // sibling mode: leave the host's layout alone
    refs.host.setAttribute("data-ub-host", "1");
  }

  // Follow LinkedIn's own theme rather than the OS preference — the two can
  // disagree, and that mismatch is what makes the card clash with the page.
  // LinkedIn marks its theme with a theme--light / theme--dark class.
  function pageTheme() {
    const root = document.documentElement;
    if (root.classList.contains("theme--dark")) return "dark";
    if (root.classList.contains("theme--light")) return "light";

    const marked = document.querySelector(".theme--dark, .theme--light");
    if (marked) return marked.classList.contains("theme--dark") ? "dark" : "light";

    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }

  function findSeeMore(postRoot) {
    for (const selector of SEE_MORE_SELECTORS) {
      const btn = postRoot?.querySelector?.(selector);
      if (btn) return btn;
    }
    return null;
  }

  // No stable post id exists in the 2026 DOM, so the text itself is the identity.
  function cacheKeyFor(text, postRoot) {
    const urn = postRoot?.getAttribute?.("data-urn");
    if (urn) return urn;
    return "h:" + hashText(text);
  }

  function hashText(value) {
    let hash = 2166136261; // FNV-1a
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function cleanText(value) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/…\s*see more\s*$/i, "")
      .replace(/\s*see more\s*$/i, "")
      .replace(/\s*show more\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const job = queue.shift();
      active++;
      process(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function process({ refs, text }) {
    if (!enabled || blocked) return;

    const response = await ask(text);

    if (!response || response.error) {
      const message = response?.error || "Summarization failed.";

      if (message === "NO_API_KEY") {
        blocked = true;
        queue.length = 0;
        renderError(refs, "No API key set — open Unbullshitter settings.");
        log("blocked: no API key configured");
        return;
      }

      diag.errors++;
      diag.lastError = message;
      renderError(refs, message);
      log("error", refs.key, message);
      return;
    }

    if (!enabled) return;

    cache.set(refs.key, response);
    persistCache();
    renderResult(refs, response);
    refs.anchor.dataset.ubState = "done";
    diag.summarized++;
    log("done", refs.key, "→", response.summary);
  }

  function ask(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "summarize", text }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  // The summary goes ABOVE the original text. Inside the commentary container
  // that means inserting as the first child (append would put it after the text);
  // in sibling mode we already sit directly before the text element.
  // Reuse an existing card if one is already in place — React may have rebuilt
  // the surrounding nodes and re-mounted the text, and we don't want two cards.
  function getBox(refs) {
    if (refs.box && refs.box.isConnected) return refs.box;

    let box = null;
    if (refs.insertBefore) {
      const prev = refs.insertBefore.previousElementSibling;
      if (prev && prev.classList.contains("ub-summary")) box = prev;
    } else if (refs.host) {
      box = [...refs.host.children].find((c) => c.classList.contains("ub-summary")) || null;
    }

    if (!box) {
      box = document.createElement("div");
      box.className = "ub-summary";

      if (refs.insertBefore && refs.insertBefore.parentNode) {
        refs.insertBefore.parentNode.insertBefore(box, refs.insertBefore);
      } else {
        refs.host.insertBefore(box, refs.host.firstChild);
      }
    }

    refs.box = box;
    box.dataset.ubTheme = pageTheme();
    return box;
  }

  // Hiding uses an inline !important declaration, not just a class: LinkedIn's
  // styles live in constructed stylesheets we can't inspect, and inline
  // !important beats anything they can declare. In inside-mode anything else in
  // the commentary container is original content, so it's hidden too.
  function hideOriginal(refs, hidden) {
    applyHidden(refs.original, hidden);
    applyHidden(refs.seeMore, hidden);

    if (!refs.insertBefore && refs.host) {
      for (const child of refs.host.children) {
        if (child.classList.contains("ub-summary")) continue;
        applyHidden(child, hidden);
      }
    }
  }

  function applyHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute("data-ub-hidden", "1");
    else el.removeAttribute("data-ub-hidden");
  }

  function renderLoading(refs) {
    const box = getBox(refs);
    box.dataset.state = "loading";
    box.dataset.ubTheme = pageTheme();
    box.textContent = "";

    const row = document.createElement("div");
    row.className = "ub-loading";

    const spinner = document.createElement("span");
    spinner.className = "ub-spinner";

    const label = document.createElement("span");
    label.textContent = "Unbullshitting…";

    row.append(spinner, label);
    box.append(row);

    hideOriginal(refs, true);
  }

  function renderResult(refs, result) {
    const box = getBox(refs);
    box.dataset.state = "done";
    box.dataset.ubTheme = pageTheme();
    box.dataset.substance = result.substance || "unknown";
    box.textContent = "";

    const meta = document.createElement("div");
    meta.className = "ub-meta";

    const dot = document.createElement("span");
    dot.className = "ub-dot";

    const badge = document.createElement("span");
    badge.className = "ub-badge";
    badge.textContent = labelFor(result);

    meta.append(dot, badge);

    const text = document.createElement("div");
    text.className = "ub-text";
    text.textContent = result.summary;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ub-toggle";
    toggle.textContent = "show the original";
    toggle.addEventListener("click", () => {
      const hidden = refs.original.hasAttribute("data-ub-hidden");
      hideOriginal(refs, !hidden);
      toggle.textContent = !hidden ? "show the original" : "hide the original";
    });

    box.append(meta, text, toggle);
    hideOriginal(refs, true);
  }

  function renderError(refs, message) {
    const box = getBox(refs);
    box.dataset.state = "error";
    box.textContent = `Unbullshitter: ${message}`;
    hideOriginal(refs, false);
  }

  function labelFor(result) {
    const kind = KIND_LABELS[result.kind] || "post";
    const substance = SUBSTANCE_LABELS[result.substance] || "";
    return substance ? `${kind} · ${substance}` : kind;
  }

  // -------------------------------------------------------------------------
  // Cache persistence
  // -------------------------------------------------------------------------

  function persistCache() {
    cacheDirty = true;
    if (persistTimer) return;

    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushCache();
    }, 1500);
  }

  function flushCache() {
    if (!cacheDirty) return;
    cacheDirty = false;

    // Newest entries win when over the cap.
    const entries = [...cache.entries()].slice(-CACHE_MAX_ENTRIES);
    cache.clear();
    for (const [key, value] of entries) cache.set(key, value);

    // Best-effort: also called from pagehide, where the write may not land.
    chrome.storage.local.set({ ub_cache: Object.fromEntries(entries) }).catch(() => {});
  }
})();
