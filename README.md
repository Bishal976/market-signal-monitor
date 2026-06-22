# Market Signal Monitor

> **⚠ Proprietary — All Rights Reserved.** This repository is public for
> portfolio/demonstration purposes only. It is **not** open source: no
> license is granted to use, copy, fork for redistribution, or create
> derivative works from any part of this code. See [`LICENSE`](LICENSE).
> Data-handling practices are documented in [`PRIVACY.md`](PRIVACY.md).

A personal CLI tool for tracking what's happening in the React / Next.js /
TypeScript / AI ecosystem in real time — what problems teams are trying to
solve, which AI tools are gaining traction, and how engineering requirements
are shifting across startups and scale-ups.

As a senior engineer leading a frontend team, staying current on where the
market is heading is part of the job. This automates the signal-gathering
so I can spend time on the insight, not the scanning.

---

## What it tracks

**Sources:**
- Hacker News — newest 20 stories every 30 minutes (Firebase API)
- Hacker News "Who is Hiring" thread — top 50 comments, checked daily
- Reddit — combined feed across 13 subreddits (startups, webdev,
  entrepreneurship, developer communities)

**What I'm watching for:**
- Which AI coding tools (Cursor, Claude Code, Lovable, v0, Bolt) are
  appearing in real engineering contexts vs. hype
- What frontend/full-stack problems teams are actively trying to solve
- How engineering requirements and team structures are evolving
- Where React / Next.js / TypeScript is being adopted or replaced

---

## Pipeline

1. **Keyword filter** — screens for terms defined in `src/config.ts`
2. **Intent filter** — removes noise (self-promotion, showcase posts,
   off-topic threads) before any AI call
3. **LLM scoring** (Groq, `llama-3.3-70b-versatile`) — rates each post
   1–10 for signal quality against a defined profile, summarises context
4. **Email digest** — high-signal posts land in inbox with a summary and
   the original context for quick review

Deduplication is handled via `seen_posts.json`, committed back to the repo
after each run so state persists across cycles.

---

## Hosting

Runs entirely on GitHub Actions — no server, no cost.

- `main-cycle.yml` — Reddit + HN scan every 30 minutes
- `hn-hiring.yml` — HN "Who is Hiring" check daily at 10:00 AM IST

Public repo = unlimited free Actions minutes. All credentials live in
GitHub's encrypted secrets vault, never in code.

---

## Why "Who is Hiring" threads specifically

These threads are one of the best unfiltered signals for how engineering
teams are actually structured and what they genuinely need — not polished
job descriptions, but founders and eng leads writing in plain language
about their actual problems. Useful data for understanding where the
industry is going.

---

## Configuration

| File | Controls |
|------|----------|
| `src/config.ts` | Keywords, subreddits, feed URL |
| `src/ai-filter.ts` | Scoring criteria, gate rules, AI call cap |
| `src/reddit.ts` | Intent filter patterns |
| `.github/workflows/` | Cron schedules |

---

## Local development

```bash
npm install
cp .env.example .env
npx ts-node src/index.ts main
npx ts-node src/index.ts hn-hiring
```

Required: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GROQ_API_KEY`
Optional: `DEBUG_FILTERING` for verbose filter logging

---

## License & Privacy

Proprietary — All Rights Reserved. See [`LICENSE`](LICENSE) for terms and
[`PRIVACY.md`](PRIVACY.md) for how this tool handles data. This repo is
public for visibility only; it is not licensed for reuse,
forking-for-redistribution, or derivative works.
