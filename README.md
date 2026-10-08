<div align="center">

# Unbullshitter

**Your LinkedIn feed, but the posts are 140 characters of whatever they were actually trying to say.**

*No server. No build step. No npm install. No 400MB of node_modules to achieve it.*

</div>

---

## The pitch

LinkedIn is the only place on the internet where someone can write six paragraphs and say nothing at all, and be *rewarded* for it. "I got rejected 47 times, then I remembered my grandfather's words." Cool. What did you actually do?

Unbullshitter reads each post, asks Google's Gemini "so… what's the news?", and swaps the whole thing for a one-line summary plus a verdict. If the post was pure engagement bait, it will tell you that, in so many words, and then *show you nothing else*, because there was nothing else.

Every card gets a badge:

| You'll see | It means |
| --- | --- |
| `insight · high substance` | Genuinely useful. Screenshot it before it scrolls away. |
| `announcement · some substance` | A thing happened. You now know what. |
| `story · low substance` | There's a plot, but no point. |
| `engagement bait · no substance` | "Agree?" No. |

Each post gets a **show the original** link, in case you want to read the version where it took eleven sentences.

---

## Install (five minutes, and most of it is Google's fault)

### 1. Get the code onto your machine

```bash
git clone git@github.com:bernardosrulzon/unbullshitter.git
```

Any folder works. No install step. I'm serious. There is no install step.

### 2. Load it into Chrome

1. Open `chrome://extensions`
2. Flip on **Developer mode** (top-right toggle). Congratulations, you are now a developer.
3. Click **Load unpacked** and pick the folder you just cloned.

If Chrome warns you about extensions in developer mode, that's just Chrome doing its job. It doesn't know you yet.

### 3. Get a Gemini API key (free)

1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**
2. Sign in, click **Create API key**, copy it.
3. It's free. The free tier is far more than a human scrolling LinkedIn will ever use.

Fair warning: on the **free tier, Google may use your inputs to improve its products.** If you'd rather it didn't, flip the API key to a paid billing project — paid-tier inputs are not used for training. Either way, the posts you read are getting sent to Google, which is a sentence worth reading twice.

### 4. Plug it in

1. Click the Unbullshitter icon in your toolbar → **Settings**
2. Paste the key, hit **Test connection** (it'll tell you if your model name is real)
3. Pick a model from the dropdown — each one shows its price per million tokens so you can be cheap on purpose

### 5. Open your feed

Go to [linkedin.com/feed](https://www.linkedin.com/feed). Scroll. Enjoy the quiet.

---

## How it actually works

```
LinkedIn tab (content script)
  ├─ finds post cards in LinkedIn's obfuscated DOM
  ├─ pulls the post text, ignores comments (they're not the enemy here)
  ├─ only summarizes what scrolls near your eyeballs
  ├─ queue (max 2 at once) + cache keyed by a hash of the text
  └─ hands the text to the background worker
        └─ POST generativelanguage.googleapis.com   ← no CORS, host permission
              └─ structured JSON back: { summary, substance, kind }
                    └─ swaps the post for a one-line card
```

The bits that matter:

- **It's not a scraper.** It reads what's already rendered on your screen, in your own logged-in tab. It doesn't log in anywhere, doesn't hit LinkedIn's API, doesn't phone home. The only network request it makes is to Google, with the post text.
- **Comments are excluded.** A comment is structurally different from a post (nested list item, or living under a subtree whose hooks say "comment"), and both signals are checked.
- **You get billed once per post, ever.** There's no stable post id in LinkedIn's 2026 markup, so the cache key is a hash of the post text. Scroll away, scroll back, reload the tab — it serves the stored summary. No second API call.
- **Only visible posts cost money.** An `IntersectionObserver` fires when a card approaches the viewport. The 400 posts you never scrolled to never get summarized.
- **The answer is JSON, not prose.** The API is called with a `responseSchema`, so we never have to strip a "Sure, here's a summary!" preamble. We ask for three fields and get three fields.
- **Updates survive React.** LinkedIn rebuilds its DOM constantly and wipes any `class` or inline `style` you dared to add. So hiding and mounting are done with `data-*` attributes, which React doesn't touch. That was a fun afternoon.

---

## Tuning the filter

The prompt lives in `src/background.js`, in a variable called `SYSTEM_PROMPT`. This is the actual product. The code is plumbing; the prompt is the opinion.

If summaries are too soft, don't write "be more concise" — the model will ignore you. **Name the specific failure mode you keep seeing** and add it to the CUT list. "CUT: humble-bravery framing, 'I was rejected X times', vague lessons about leadership." Named patterns work. Adjectives don't.

## Models and money

Pick from the dropdown in Settings. Each entry shows standard paid-tier pricing per 1M tokens and whether it's on the free tier. Default is `gemini-3.8-flash`, which is a lot of model for a job that's basically "read this and get to the point."

Want to be cheap? `gemini-3.5-flash-lite` costs about a tenth and is plenty. Want to be expensive for no reason? The Pro models are in the list. Summarizing 140 characters is not a reasoning-heavy task, so the extension tells Gemini 3.x to think at `thinkingLevel: "low"`. Thinking tokens are billed as output tokens, and we're not paying for the model to ponder your feed.

Older models get `temperature` instead. The extension works out which config your model wants; if it guesses wrong, it drops the offending field and retries.

---

## Patience vs. speed (and what to do when it dies)

Settings has a **Gemini plan** switch. Free tier summarizes **one post at a time**; paid tier does **two**. The free tier's rate limits are tight enough that being polite is the difference between "works" and "429s all afternoon". If you're on a billing project, turn it up and the feed fills in twice as fast.

And when a request does fall over — rate limit, flaky wifi, a key you pasted with a trailing space — the error card grows a **retry** button. It re-queues that one post, clears the "no key" lockout in case you just fixed it, and has another go. No reloading, no re-scrolling, and none of the dozen posts that were already fine get re-summarized.

---

## When it breaks (it will)

LinkedIn changes its markup the way other companies change their office plants: constantly, and without telling anyone. As of the 2026 server-driven UI rollout:

- posts have **no `data-urn`** anymore,
- class names are obfuscated into `ebu*` gibberish,
- post text lives in `span[data-testid="expandable-text-box"]`.

If posts stop being summarized, the first thing to check is `TEXT_SELECTORS` in `src/content.js`. LinkedIn moved the furniture; you move the selector. That's the whole maintenance story.

Open the DevTools console and look for `[UB]` logs — the extension narrates what it's doing. The toolbar popup also has a diagnostics panel: posts found, comments skipped, summaries served from cache, last error.

---

## Files

| File | What's in it |
| --- | --- |
| `manifest.json` | MV3 manifest. Two permissions, one host, no drama. |
| `src/background.js` | Talks to Gemini. Holds the prompt, retries, and the JSON schema. |
| `src/content.js` | Finds posts, extracts text, queues, caches, renders, hides originals. |
| `src/content.css` | The card, in LinkedIn's own colors, in light and dark. |
| `src/options.*` | Where you paste the key and pick a model. |
| `src/popup.*` | Toolbar toggle and the diagnostics panel. |

---

## FAQ

**Does this send my data anywhere creepy?**
It sends post text to Google's Gemini API. That's the entire business model of a summarizer. There's no server in the middle, no analytics, no telemetry, no "anonymous usage statistics."

**It says "no substance" but the post had substance.**
The model only sees the text, not the link it points to, the author, or the engagement. "We published our results, link below" looks thin to a model that can't click. Also, sometimes the model is just wrong. It's a language model, not a judge.

**Can I turn it off?**
Toolbar icon → toggle. Originals come back instantly. It's a class attribute; nothing was ever destroyed.

**Why "Unbullshitter"?**
Because "LinkedIn Feed Optimization Suite" doesn't have the same ring to it.
