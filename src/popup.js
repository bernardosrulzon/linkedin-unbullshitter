// LinkedIn Unbullshitter — toolbar popup + diagnostics panel.

const enabledEl = document.getElementById("enabled");
const subEl = document.getElementById("sub");
const gridEl = document.getElementById("diagGrid");
const errorEl = document.getElementById("diagError");
const refreshEl = document.getElementById("refresh");
const reloadEl = document.getElementById("reload");
const settingsEl = document.getElementById("settings");

let activeTab = null;
let hasKey = false;

init();

async function init() {
  const { ub_settings = {} } = await chrome.storage.local.get("ub_settings");
  enabledEl.checked = ub_settings.enabled !== false;
  hasKey = Boolean(ub_settings.apiKey);
  subEl.textContent = hasKey ? "Gemini key configured" : "No API key — open Settings";

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  refresh();
}

enabledEl.addEventListener("change", async () => {
  const { ub_settings = {} } = await chrome.storage.local.get("ub_settings");
  await chrome.storage.local.set({
    ub_settings: { ...ub_settings, enabled: enabledEl.checked },
  });
  subEl.textContent = enabledEl.checked ? "On" : "Off";
});

refreshEl.addEventListener("click", refresh);

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
    gridEl.textContent = "";
    errorEl.textContent = "Open a LinkedIn feed tab, then reopen this popup.";
    return;
  }

  chrome.tabs.sendMessage(activeTab.id, { type: "diagnostics" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      gridEl.textContent = "";
      errorEl.textContent =
        "Content script isn't responding. Reload the LinkedIn tab, then reopen this popup.";
      return;
    }
    render(res);
  });
}

function render(res) {
  const d = res.diag || {};
  const rows = [
    ["Posts in DOM", d.postsInDom ?? 0],
    ["Comments skipped", d.commentsSkipped ?? 0],
    ["Queued for summary", d.watched ?? 0],
    ["Summarized", d.summarized ?? 0],
    ["  of which cached", d.fromCache ?? 0],
    ["Skipped (no text)", d.skipped ?? 0],
    ["Errors", d.errors ?? 0],
    ["Cached posts", res.cachedPosts ?? 0],
    ["In flight", res.active ?? 0],
  ];

  gridEl.innerHTML = "";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    gridEl.append(dt, dd);
  }

  const problems = [];
  if (!hasKey) problems.push("No API key set.");
  if (res.blocked) problems.push("Worker reported no API key.");
  if (!res.enabled) problems.push("Extension is toggled off.");
  if (d.errors) problems.push(`${d.errors} error(s): ${d.lastError || "unknown"}`);
  if (!d.postsInDom) problems.push("No posts found — LinkedIn's DOM may have changed.");
  else if (!d.summarized && !d.errors) {
    problems.push("Posts found but none summarized yet — scroll the feed.");
  }

  errorEl.textContent = problems.length ? problems.join(" ") : "All good.";
  errorEl.dataset.tone = problems.length ? "bad" : "ok";
}
