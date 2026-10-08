// LinkedIn Unbullshitter — toolbar popup.
//
// Two tiers on purpose: one plain-English status line for the person using it,
// and the raw counters folded away behind "Technical details" for when something
// breaks and we need numbers.

const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const techEl = document.getElementById("tech");
const gridEl = document.getElementById("diagGrid");
const reloadEl = document.getElementById("reload");
const settingsEl = document.getElementById("settings");

let activeTab = null;
let hasKey = false;

init();

async function init() {
  const { ub_settings = {} } = await chrome.storage.local.get("ub_settings");
  enabledEl.checked = ub_settings.enabled !== false;
  hasKey = Boolean(ub_settings.apiKey);

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  refresh();
  // Live status while the popup is open, so nobody has to know to press
  // "Refresh" to find out whether it's working.
  setInterval(refresh, 1000);
}

enabledEl.addEventListener("change", async () => {
  const { ub_settings = {} } = await chrome.storage.local.get("ub_settings");
  await chrome.storage.local.set({
    ub_settings: { ...ub_settings, enabled: enabledEl.checked },
  });
  refresh();
});

reloadEl.addEventListener("click", () => {
  if (activeTab?.id) chrome.tabs.reload(activeTab.id);
  window.close();
});

settingsEl.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

function refresh() {
  if (!activeTab || !/linkedin\.com/.test(activeTab.url || "")) {
    setStatus("Open your LinkedIn feed to see what's happening.", "muted");
    renderGrid(null);
    return;
  }

  chrome.tabs.sendMessage(activeTab.id, { type: "diagnostics" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setStatus("Couldn't reach the page. Reload LinkedIn and try again.", "bad");
      renderGrid(null);
      return;
    }
    const status = statusFor(res);
    setStatus(status.text, status.tone);
    renderGrid(res);
  });
}

// One sentence, in plain English, that answers "is it working?".
function statusFor(res) {
  if (!hasKey) return { text: "No API key yet — open Settings to add one.", tone: "bad" };
  if (!res.enabled) return { text: "Paused. Turn it back on to compress posts.", tone: "muted" };

  const d = res.diag || {};

  if (d.errors) {
    return {
      text: `Couldn't summarize ${d.errors} post${d.errors === 1 ? "" : "s"} — use the retry button on the card.`,
      tone: "bad",
    };
  }

  if (!d.postsInDom) {
    return {
      text: "No posts found. Open your feed — or reload the page if you're already there.",
      tone: "bad",
    };
  }

  if (res.active || res.queue) {
    return { text: `Summarizing… ${res.active + res.queue} to go.`, tone: "muted" };
  }

  if (d.summarized) {
    return {
      text: `Working — ${d.summarized} post${d.summarized === 1 ? "" : "s"} summarized.`,
      tone: "ok",
    };
  }

  return { text: "Working — scroll your feed to start.", tone: "ok" };
}

function setStatus(text, tone) {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function renderGrid(res) {
  if (!res) {
    techEl.hidden = true;
    gridEl.textContent = "";
    return;
  }

  const d = res.diag || {};
  const rows = [
    ["Posts on this page", d.postsInDom ?? 0],
    ["Comments skipped", d.commentsSkipped ?? 0],
    ["Waiting to summarize", d.watched ?? 0],
    ["Summarized", d.summarized ?? 0],
    ["  served from cache", d.fromCache ?? 0],
    ["Skipped (too little text)", d.skipped ?? 0],
    ["Errors", d.errors ?? 0],
    ["Cached summaries", res.cachedPosts ?? 0],
    ["In progress", res.active ?? 0],
  ];
  if (d.lastError) rows.push(["Last error", d.lastError]);

  gridEl.innerHTML = "";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    gridEl.append(dt, dd);
  }

  techEl.hidden = false;
}
