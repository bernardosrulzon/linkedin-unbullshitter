// LinkedIn Unbullshitter — background service worker.
//
// The content script never talks to Google directly (the page context would hit
// CORS). It forwards post text here, and this worker calls the Gemini API using
// the host permission declared in the manifest.

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_SUMMARY_CHARS = 160; // hard cap before truncating; the model is asked for 140
const MAX_TEXT_CHARS = 6000;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Structured output schema — makes the response trivially parseable and stops
// the model from wrapping the answer in prose.
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "The concrete point of the post in plain English, 140 characters or fewer. Return an empty string when the post genuinely carries no point.",
    },
    substance: {
      type: "string",
      enum: ["high", "medium", "low", "none"],
      description:
        "How much real substance the post has, on a high bar. 'high' is rare: an original point of view or hard-won, specific insight. Generic advice, platitudes, filler and AI-generated prose are 'low'. 'none' means the post contains no information at all — never use it just because a post is short, low-effort, or you are unsure. If you could write a summary, the grade is at least 'low'.",
    },
    kind: {
      type: "string",
      enum: [
        "insight",
        "story",
        "personal",
        "announcement",
        "hiring",
        "promo",
        "engagement_bait",
        "news",
        "question",
        "other",
      ],
      description: "The dominant type of post.",
    },
  },
  required: ["summary", "substance", "kind"],
};

// The prompt is the product. Everything here targets a specific failure mode of
// LinkedIn writing: hype, humble-bravery, engagement bait, and vague "lessons".
const SYSTEM_PROMPT = `You are a ruthlessly concise editor. You strip LinkedIn bloat down to what is actually being communicated.

You receive the text of one LinkedIn post. Reply with JSON matching the schema.

The "summary" field:
- State the single most important concrete point in plain English, 140 characters or fewer.
- Lead with the substance: the claim, number, result, event, offer, or question. Never lead with how the author feels or what they "learned".
- Keep real specifics: names, companies, numbers, outcomes, technical details.
- Cut: hype adjectives (incredible, game-changing, humbling, excited, thrilled), motivational filler, "Here's what I learned", vague life lessons, engagement bait ("Agree?", "Thoughts?", "Repost if...", "Comment below"), emoji, hashtags, and the word "journey".
- Do not editorialize, give advice, or add an opinion. Report what is there, nothing more.
- Never write "This post", "The author", or "He/She".
- Write the summary in the same language as the post. A Portuguese post gets a Portuguese summary, a Spanish post a Spanish one.
- No emoji, no hashtags, no markdown, no surrounding quotes.
- If the post tells a story, give the outcome, not the suspense.
- If the post sells something, name what is being sold.
- If the post is only a question, restate the actual question plainly.
- Never make a thin post sound more substantial than it is. If there is barely a point, the summary should make that obvious.
- If the post genuinely carries no point — the author wrote words and said nothing — return an empty string for the summary. Never invent a point, and never return placeholder text.
- A short but complete claim ("rates cut 25bps") is a real summary, so write it. Only return empty when there is truly nothing.

The "substance" field. This is a professional network, so the bar is high: most posts are "low" or "medium". Be stingy with "high".

- "high" — Rare. A genuinely original point of view, a non-obvious insight, or hard-won first-hand detail a peer could not have got by scrolling. It teaches a professional something they did not already know, or reframes something they thought they did. Test: strip the company and industry names — if the point reads exactly the same without them, it is not high. A contrarian take qualifies only when it is backed by specifics.
- "medium" — Real but ordinary: a competent observation, an expected update with some detail, or a claim that is thin on evidence. Specific enough to be useful, but not interesting. This is the default for a post that is neither obvious filler nor original.
- "low" — Filler. Generic advice that would fit any job or industry, motivational platitudes, life lessons, humble-bravery, announcing something with no substance, consensus opinions dressed up as insight, engagement bait with a thin factual shell, and anything that reads as AI-generated. Test: could this have been written by someone who does not actually do the work? If yes, it is low.
- "none" — the post contains no information at all. This is rare, and it is not the same as "short", "unimpressive" or "not my subject". If you were able to write a summary, the grade is at least "low".

Signals of low substance: tidy list-shaped prose with balanced clauses and no real specifics; "it is not X, it is Y" constructions; a dramatic hook followed by an obvious payoff; borrowed authority with no first-hand detail; congratulating; reposting without adding anything.

When you are torn between two levels, choose the lower one.

The "kind" field — the dominant type of post. When two seem to fit, use this order of precedence:

1. "promo" — selling a product, service, course, or the author's own offering.
2. "hiring" — a job opening or a recruiting call to action.
3. "personal" — the author sharing their own life or career, not a professional argument: a new role, a promotion, an award, a work anniversary, a milestone, a conference or event they attended, congratulations, travel, a personal photo, a reflection about themselves. Personal news goes here even when it is also an announcement.
4. "news" — reporting something that happened in the industry, a company, or the world.
5. "announcement" — an organisation, team or product announcing something, where the author is not the news.
6. "insight" — the author making an argument, an analysis, or stating a point of view.
7. "story" — a narrative told to make a point.
8. "question" — the post is mostly asking the reader something.
9. "engagement_bait" — no real content, just a prompt for reactions.
10. "other" — none of the above.

Respond with JSON only.`;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "summarize") {
    summarize(msg.text)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || "Unknown error" }));
    return true; // keep the channel open for the async response
  }

  if (msg.type === "testKey") {
    testKey()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || "Unknown error" }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const { ub_settings = {} } = await chrome.storage.local.get("ub_settings");
  return {
    apiKey: (ub_settings.apiKey || "").trim(),
    model: (ub_settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

async function summarize(rawText) {
  const text = String(rawText || "").trim().slice(0, MAX_TEXT_CHARS);
  if (text.length < 20) {
    return { summary: "Nothing of substance.", substance: "none", kind: "other" };
  }

  const { apiKey, model } = await getSettings();
  if (!apiKey) return { error: "NO_API_KEY" };

  let body = makeRequestBody(model, text);

  const url = `${API}/${encodeURIComponent(model)}:generateContent`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(
          res.status === 429 ? "Rate limited (429)" : `Server error (${res.status})`,
        );
        await sleep(600 * 2 ** (attempt - 1));
        continue;
      }

      if (!res.ok) {
        const detail = await safeJson(res);
        const message = detail?.error?.message || `HTTP ${res.status}`;

        // This API rejects unknown fields outright, and thinking config support
        // varies by model/version. If it complains about thinking, drop the
        // field, remember it, and retry — a slightly slower summary beats none.
        if (res.status === 400 && /thinking/i.test(message) && body.generationConfig.thinkingConfig) {
          thinkingRejected = true;
          body = makeRequestBody(model, text);
          continue;
        }

        throw new Error(message);
      }

      const data = await res.json();
      return parseResponse(data);
    } catch (err) {
      lastError =
        err?.name === "AbortError"
          ? new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)
          : err;
      if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
    } finally {
      // A stalled request must never leave a post stuck on "Unbullshitting…".
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Request failed");
}

// Gemini 3.x ignores the legacy sampling params (temperature, top_p, top_k) and
// replaces thinking_budget with a thinking_level enum. Note the nesting: the
// level lives at generationConfig.thinkingConfig.thinkingLevel — putting it
// directly on generationConfig is a 400, because this API rejects unknown
// fields instead of ignoring them. Older models still take temperature.
let thinkingRejected = false; // set once a model tells us it won't take thinkingConfig

function makeRequestBody(model, text) {
  const generationConfig = {
    maxOutputTokens: 2048, // headroom for thinking tokens on 3.x
    responseMimeType: "application/json",
    responseSchema: SCHEMA,
  };

  if (/^gemini-3(\.|$)/.test(model)) {
    if (!thinkingRejected) {
      generationConfig.thinkingConfig = { thinkingLevel: "low" }; // summarizing isn't reasoning-heavy
    }
  } else {
    generationConfig.temperature = 0.2;
  }

  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig,
  };
}

function parseResponse(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const block = data?.promptFeedback?.blockReason;
    if (block) return { error: `Blocked by safety filter (${block})` };
    return { error: "Empty response from model" };
  }

  const text = (candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Model ignored the schema; fall back to treating the raw text as summary.
  }

  return normalize(parsed, text);
}

const VALID_SUBSTANCE = new Set(["high", "medium", "low", "none"]);
const VALID_KIND = new Set([
  "insight",
  "story",
  "personal",
  "announcement",
  "hiring",
  "promo",
  "engagement_bait",
  "news",
  "question",
  "other",
]);

function normalize(parsed, fallbackText) {
  let summary = String(parsed?.summary ?? fallbackText ?? "").trim();
  summary = summary
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // An older prompt asked the model to signal these inside the summary field.
  // Treat any straggler as "no summary": the wording that follows is decided from
  // how much text there actually was, which is the only reliable evidence.
  if (/^<?\s*<?\s*(EMPTY|SHORT)\s*>?\s*>?$/i.test(summary)) summary = "";

  let substance = VALID_SUBSTANCE.has(parsed?.substance) ? parsed.substance : "unknown";
  const kind = VALID_KIND.has(parsed?.kind) ? parsed.kind : "other";

  if (!summary) {
    // Nothing to say. Whether that reads as "nothing of substance" or "short
    // content" is not the model's call — it depends on how much text we had.
    return { summary: "", substance: "none", kind };
  }

  // A summary exists, so there IS something there. "none" would contradict the
  // sentence we just wrote, and the model over-applies it to anything it finds
  // unimpressive. Never throw away a summary over a grade.
  if (substance === "none") substance = "low";

  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + "…";
  }

  return { summary, substance, kind };
}

// ---------------------------------------------------------------------------
// Key validation (used by the options page)
// ---------------------------------------------------------------------------

async function testKey() {
  const { apiKey } = await getSettings();
  if (!apiKey) return { error: "NO_API_KEY" };

  const res = await fetch(`${API}?pageSize=200`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!res.ok) {
    const detail = await safeJson(res);
    return { error: detail?.error?.message || `HTTP ${res.status}` };
  }

  const data = await res.json();
  const models = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));

  return { ok: true, models };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
