<div align="center">

# Unbullshitter

**Your LinkedIn feed, with the waffle removed.**

</div>

---

LinkedIn is the one place where a person can write six paragraphs and say nothing — and get applauded for it. Unbullshitter reads each post, asks Google's Gemini "so what?", and replaces the whole thing with a one-line summary and an honest verdict.

A real post? You get the point. Pure bait? It says so, and shows you nothing else.

| The badge | What it means |
| --- | --- |
| `insight · high substance` | Actually useful. |
| `announcement · some substance` | A thing happened. |
| `story · low substance` | A story with no point. |
| `engagement bait · no substance` | "Agree?" — No. |

## Install (5 minutes, no coding required)

**1. Download it**

Click the green **Code** button at the top of this page → **Download ZIP**. Unzip it somewhere you'll remember (the Desktop is fine).

**2. Add it to Chrome**

1. Open a new tab and type `chrome://extensions`
2. Turn on **Developer mode** — the switch in the top-right corner
3. Click **Load unpacked** and select the folder you unzipped

Chrome will warn you about developer-mode extensions. That's normal — it just hasn't met this one yet.

Can't see the icon afterwards? Click the puzzle-piece icon in your toolbar and pin **Unbullshitter**.

**3. Get a free Gemini key**

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in, click **Create API key**, and copy it

It's free, and the free quota is more than you'll ever use scrolling LinkedIn.

**4. Connect the two**

1. Click the **Unbullshitter** icon → **Settings**
2. Paste your key and click **Test connection** — it'll tell you if it works
3. That's it. The default model is fine.

**5. Open your feed**

Go to [linkedin.com/feed](https://www.linkedin.com/feed) and scroll.

## Try it

- **Scroll** — posts turn into short summaries as they reach your screen. Posts further down wait until you get to them.
- **Show the original** — one click on any card. Click again to hide it.
- **Turn it off** — toolbar icon → toggle. Your feed comes back instantly.
- **Something didn't load?** — press the **retry** button on the card.

## Changing how it works

Toolbar icon → **Settings**. There are only two things worth touching:

- **Model** — the default is cheap and does this job well. Fancier models cost more and aren't noticeably better here.
- **Free vs paid** — *Free tier* handles one post at a time, *Paid tier* two. Free is the default, and it's fine.

## What leaves your computer

Just the text of the post being summarized, sent to Google's Gemini API. That's the entire job — no server in the middle, no analytics, no account, no tracking.

On Google's free tier, your input may be used to improve their products. If you'd rather it weren't, use a paid API key.

## If posts stop being summarized

LinkedIn rearranges its website constantly, and one day it'll rearrange the part this reads. You'll notice immediately: posts stop shrinking.

Click the toolbar icon for a quick health check — posts found, comments skipped, summaries served, last error.

## Fine print

- It only reads what's already on your screen, in your own logged-in browser. No scraping, no server, nothing logged in on your behalf.
- Comments are never touched. Only posts.
- Summaries are cached, so scrolling back up (or reloading) costs nothing.
- Nothing is deleted. The original post is still in the page, hidden behind a **data attribute** — flip the toggle and it's back.

Not affiliated with LinkedIn. Built for personal use.
