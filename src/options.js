// LinkedIn Unbullshitter — options page.

const DEFAULT_MODEL = "gemini-3.8-flash";
const CUSTOM = "__custom__";

// Standard paid-tier prices in USD per 1M tokens, plus free-tier availability.
// Source: ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-07).
// Only text models that support generateContent are listed.
const MODELS = [
  // --- Gemini 3 (current) ---
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    family: "Gemini 3 (current)",
    in: 0.75,
    out: 3.75,
    free: true,
    note: "Intro price — $1.50 / $7.50 from Jan 1, 2027. Best quality/cost.",
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    family: "Gemini 3 (current)",
    in: 0.75,
    out: 3.75,
    free: true,
    note: "Intro price — $1.50 / $7.50 from Jan 1, 2027.",
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    family: "Gemini 3 (current)",
    in: 0.75,
    out: 3.75,
    free: true,
    note: "Intro price — $1.50 / $7.50 from Jan 1, 2027.",
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    family: "Gemini 3 (current)",
    in: 1.5,
    out: 9.0,
    free: true,
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    family: "Gemini 3 (current)",
    in: 0.3,
    out: 2.5,
    free: true,
    note: "Cheapest current-generation option.",
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite",
    family: "Gemini 3 (current)",
    in: 0.25,
    out: 1.5,
    free: true,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (preview)",
    family: "Gemini 3 (current)",
    in: 0.5,
    out: 3.0,
    free: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro (preview)",
    family: "Gemini 3 (current)",
    in: 2.0,
    out: 12.0,
    free: false,
    note: "Overkill for summarizing. $4.00 / $18.00 above 200k input tokens.",
  },
];

const money = (n) => "$" + n.toFixed(2);

const $ = (id) => document.getElementById(id);
const apiKeyEl = $("apiKey");
const modelSelectEl = $("modelSelect");
const modelCustomEl = $("modelCustom");
const modelDetailEl = $("modelDetail");
const enabledEl = $("enabled");
const revealEl = $("reveal");
const testEl = $("test");
const testResultEl = $("testResult");
const saveEl = $("save");
const saveResultEl = $("saveResult");

buildModelSelect();
init();

// -------------------------------------------------------------------------
// Model dropdown
// -------------------------------------------------------------------------

function buildModelSelect() {
  const families = new Map();
  for (const model of MODELS) {
    if (!families.has(model.family)) families.set(model.family, []);
    families.get(model.family).push(model);
  }

  for (const [family, list] of families) {
    const group = document.createElement("optgroup");
    group.label = family;

    for (const model of list) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent =
        `${model.name} — ${money(model.in)} in / ${money(model.out)} out per 1M` +
        (model.free ? " · free tier" : "");
      group.append(option);
    }

    modelSelectEl.append(group);
  }

  const custom = document.createElement("option");
  custom.value = CUSTOM;
  custom.textContent = "Custom model…";
  modelSelectEl.append(custom);
}

function updateModelDetail() {
  const model = MODELS.find((m) => m.id === modelSelectEl.value);
  const isCustom = modelSelectEl.value === CUSTOM;

  modelCustomEl.hidden = !isCustom;

  if (!model) {
    modelDetailEl.textContent = isCustom
      ? "Enter any model ID that supports generateContent."
      : "";
    return;
  }

  const bits = [
    `Input ${money(model.in)} / output ${money(model.out)} per 1M tokens`,
    model.free ? "free tier available" : "paid tier only",
  ];
  if (model.note) bits.push(model.note);
  modelDetailEl.textContent = bits.join(" · ");
}

function effectiveModel() {
  if (modelSelectEl.value === CUSTOM) return modelCustomEl.value.trim();
  return modelSelectEl.value;
}

// -------------------------------------------------------------------------
// Wiring
// -------------------------------------------------------------------------

modelSelectEl.addEventListener("change", () => {
  updateModelDetail();
  saveResultEl.textContent = "";
});

modelCustomEl.addEventListener("input", () => {
  saveResultEl.textContent = "";
});

revealEl.addEventListener("click", () => {
  const showing = apiKeyEl.type === "text";
  apiKeyEl.type = showing ? "password" : "text";
  revealEl.textContent = showing ? "Show" : "Hide";
});

saveEl.addEventListener("click", async () => {
  await save();
  flash(saveResultEl, "Saved", "ok");
});

// Auto-save the toggle immediately — it's the one control people expect to be instant.
enabledEl.addEventListener("change", async () => {
  await save();
  flash(saveResultEl, enabledEl.checked ? "On" : "Off", "ok");
});

testEl.addEventListener("click", async () => {
  await save(); // make sure the worker reads what's on screen
  const model = effectiveModel();
  setStatus(testResultEl, "Testing…", "muted");

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "testKey" }, (res) => {
      resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : res);
    });
  });

  if (response?.error === "NO_API_KEY") {
    setStatus(testResultEl, "Add a key first", "bad");
  } else if (response?.error) {
    setStatus(testResultEl, `Failed: ${response.error}`, "bad");
  } else if (!response.models.includes(model)) {
    setStatus(testResultEl, `Key works, but "${model}" isn't in your model list`, "warn");
  } else {
    setStatus(testResultEl, `OK — ${model} is available`, "ok");
  }
});

// -------------------------------------------------------------------------
// Load / save
// -------------------------------------------------------------------------

async function init() {
  const { ub_settings = {} } = await chrome.storage.local.get("ub_settings");

  apiKeyEl.value = ub_settings.apiKey || "";
  enabledEl.checked = ub_settings.enabled !== false;

  const stored = ub_settings.model || DEFAULT_MODEL;
  if (MODELS.some((m) => m.id === stored)) {
    modelSelectEl.value = stored;
  } else {
    modelSelectEl.value = CUSTOM;
    modelCustomEl.value = stored;
  }
  updateModelDetail();
}

async function save() {
  const settings = {
    apiKey: apiKeyEl.value.trim(),
    model: effectiveModel() || DEFAULT_MODEL,
    enabled: enabledEl.checked,
  };
  await chrome.storage.local.set({ ub_settings: settings });
}

function setStatus(el, text, tone) {
  el.textContent = text;
  el.dataset.tone = tone;
}

function flash(el, text, tone) {
  setStatus(el, text, tone);
  setTimeout(() => {
    el.textContent = "";
  }, 2000);
}
