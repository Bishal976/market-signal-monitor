# Job Alert Monitor

An automated lead-monitoring CLI for freelance/contract frontend work. It polls Reddit
and Hacker News for relevant posts, filters out noise, scores the remaining leads with
an LLM, and emails you the strong matches with a ready-to-send outreach draft.

## How it works

1. **Sources** (polled every 30 minutes):
   - Hacker News — newest 20 stories (official Firebase API)
   - Hacker News "Who is Hiring" thread — top 50 comments, checked once at startup
     (delayed 2 min) and daily at 10:00 AM
   - Reddit RSS — r/forhire, r/hiring, r/webdev

2. **Keyword match** — a post must mention at least one of the keywords in
   `KEYWORDS` (`src/config.ts`), e.g. React, Next.js, TypeScript, frontend, AI
   integration.

3. **Dedup** — seen post/comment IDs are tracked per-source in `seen_posts.json`
   (FIFO-pruned at 1000 entries, written once per run).

4. **Intent pre-filter** (Reddit only, before any AI call) — rejects freelancer
   self-ads on r/forhire and showcase/weekly threads on r/webdev.

5. **AI scoring + drafting** (Groq, `llama-3.3-70b-versatile`) — scores each
   remaining post 1-10 for fit against a hardcoded persona/profile, gated on real
   buying intent (not a showcase, not unpaid, not the author's own services). If
   the score is ≥ 6, it also drafts a 2-3 paragraph outreach reply.

6. **Per-cycle AI call cap** — at most 5 AI calls per cycle. Anything over the cap
   isn't dropped — it's collected into a single digest email for manual review.

7. **Email** (Gmail SMTP) — three possible email types per cycle:
   - `[LEAD x/10] {title}` — AI-scored match with reasoning + drafted reply
   - `[LEAD - NO AI] {title}` — AI call failed, but the lead wasn't dropped
   - `[LEADS DIGEST - REVIEW MANUALLY]` — leads skipped due to the AI call cap

Each source runs independently — if one fails (network error, feed down, etc.) the
others still run and the error is logged.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `GMAIL_USER` — your Gmail address
- `GMAIL_APP_PASSWORD` — a Gmail [App Password](https://myaccount.google.com/apppasswords)
  (requires 2FA enabled on your Google account; do NOT use your normal password)
- `GROQ_API_KEY` — free key from [console.groq.com/keys](https://console.groq.com/keys)

Startup will exit with an error if any of these three are missing.

## Running

```bash
npm run dev     # ts-node, for local development
npm run build   # compile to dist/
npm start       # run compiled output
```

## Configuration

- `KEYWORDS`, `REDDIT_FEEDS` — `src/config.ts`
- AI persona, gate-check rules, score threshold, budget guidance,
  `MAX_AI_CALLS_PER_CYCLE` — `src/ai-filter.ts`
- Reddit intent-filter patterns — `passesIntentFilter()` in `src/reddit.ts`
- Cron schedules (`*/30 * * * *` main cycle, `0 10 * * *` HN hiring thread) —
  `src/index.ts`

## Dedup

Seen post/comment IDs are stored in `seen_posts.json` (created on first run,
gitignored). Delete this file to re-alert on everything currently in the feeds.
