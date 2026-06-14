// Last updated: 2026-06-14 — batch dedup writes (single seen_posts.json write per run)
import axios from "axios";
import { fetchFeed, RssEntry } from "./rss";
import { isSeen, markSeenBatch } from "./dedup";
import { sendJobAlert } from "./mailer";
import { analyzeAndDraft, canMakeAiCall, incrementAiCallCount, addCappedLead } from "./ai-filter";
import { REDDIT_FEEDS, matchesKeywords } from "./config";
import { JobPost } from "./types";

/** Strips HTML tags and collapses whitespace, for use as an email/AI-prompt snippet. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

const WEBDEV_SHOWCASE_PATTERNS = [
  "showoff saturday",
  "show and tell",
  "monthly",
  "weekly thread",
  "what are you working on",
  "i built",
  "show hn",
];

/**
 * Pre-filters posts by intent before they reach the AI, to avoid wasting
 * API calls on freelancer self-ads and community showcase threads.
 */
function passesIntentFilter(feedUrl: string, title: string): boolean {
  const lower = title.toLowerCase();

  if (feedUrl.includes("/r/forhire/")) {
    if (lower.includes("[for hire]") || lower.includes("for hire")) {
      console.log(`[INTENT-FILTER] Skipped: ${title}`);
      return false;
    }
    if (lower.includes("[hiring]") || lower.startsWith("hiring")) return true;
    console.log(`[INTENT-FILTER] Skipped: ${title}`);
    return false;
  }

  if (feedUrl.includes("/r/webdev/")) {
    if (WEBDEV_SHOWCASE_PATTERNS.some((pattern) => lower.includes(pattern))) {
      console.log(`[INTENT-FILTER] Skipped: ${title}`);
      return false;
    }
    return true;
  }

  return true;
}

const RETRY_DELAY_MS = 30_000;
const FEED_DELAY_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 429 retry preserved after cron change
/** Fetches a feed, retrying once after a 30s delay if rate-limited (429). */
async function fetchFeedWithRetry(url: string): Promise<RssEntry[]> {
  try {
    return await fetchFeed(url);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      console.warn(`[REDDIT] 429 rate limited on ${url}, retrying in 30s...`);
      await sleep(RETRY_DELAY_MS);
      return await fetchFeed(url);
    }
    throw err;
  }
}

export async function runRedditMonitor(): Promise<void> {
  const timestamp = new Date().toISOString();
  let matched = 0;
  let errors = 0;
  const seenBatch: Array<{ id: string; source: string }> = [];

  for (let i = 0; i < REDDIT_FEEDS.length; i++) {
    const feedUrl = REDDIT_FEEDS[i];
    if (i > 0) await sleep(FEED_DELAY_MS);

    try {
      const entries = await fetchFeedWithRetry(feedUrl);

      for (const entry of entries) {
        const text = `${entry.title} ${entry.description}`;
        if (!matchesKeywords(text)) continue;
        if (isSeen("REDDIT", entry.id)) continue;
        seenBatch.push({ id: entry.id, source: "REDDIT" });
        if (!passesIntentFilter(feedUrl, entry.title)) continue;

        const job: JobPost = {
          id: entry.id,
          source: "REDDIT",
          title: entry.title,
          url: entry.link,
          detail: stripHtml(entry.description),
          posted: entry.pubDate,
        };

        if (!canMakeAiCall()) {
          console.log("[AI-FILTER] Cycle cap reached, skipping remaining matches.");
          addCappedLead({ title: job.title, url: job.url });
          continue;
        }
        incrementAiCallCount();

        try {
          const aiResult = await analyzeAndDraft(job);
          if (!aiResult) continue;
          await sendJobAlert(job, aiResult);
        } catch (err) {
          console.error("[AI-FILTER] error:", (err as Error).message);
          await sendJobAlert(job);
        }
        matched++;
      }
    } catch (err) {
      errors++;
      console.error(`[${timestamp}] [REDDIT] Error fetching ${feedUrl}:`, (err as Error).message);
    }
  }

  markSeenBatch(seenBatch);
  console.log(`[${timestamp}] [REDDIT] Run complete. New matches: ${matched}, feed errors: ${errors}`);
}
