// Last updated: 2026-06-16 — BUG2: r/hiring seller filter; BUG3: universal showcase/seller filter
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

const FOR_HIRE_PATTERNS = [
  "[for hire]",
  "[forhire]",
  "for hire",
  "available for hire",
  "available for work",
  "offering my services",
];

const WEBDEV_SHOWCASE_PATTERNS = [
  "showoff saturday",
  "show and tell",
  "show hn",
  "monthly",
  "weekly thread",
  "what are you working on",
  "i built",
  "i made",
  "i created",
  "just launched",
  "just shipped",
  "side project",
  "[oc]",
  "open source",
  "free for solo",
];

/**
 * Pre-filters posts by intent before they reach the AI, to avoid wasting
 * API calls on freelancer self-ads and community showcase threads.
 * Universal seller/showcase checks run first and apply to ALL feed sources.
 */
function passesIntentFilter(feedUrl: string, title: string): boolean {
  const lower = title.toLowerCase();

  // Universal showcase/builder exclusions — apply to ALL feeds
  if (WEBDEV_SHOWCASE_PATTERNS.some((pattern) => lower.includes(pattern))) {
    console.log(`[INTENT-FILTER] Skipped (showcase pattern): ${title}`);
    return false;
  }

  // Universal seller exclusions — apply to ALL feeds
  if (FOR_HIRE_PATTERNS.some((p) => lower.includes(p))) {
    console.log(`[INTENT-FILTER] Skipped (seller): ${title}`);
    return false;
  }

  // r/forhire: require an explicit hiring signal in the title
  if (feedUrl.includes("/r/forhire/")) {
    if (lower.includes("[hiring]") || lower.startsWith("hiring")) return true;
    console.log(`[INTENT-FILTER] Skipped (r/forhire no hiring signal): ${title}`);
    return false;
  }

  // r/hiring: seller posts already caught above; remaining posts are buyer-side
  if (feedUrl.includes("/r/hiring/")) {
    return true;
  }

  // r/webdev: showcase patterns already caught above
  if (feedUrl.includes("/r/webdev/")) {
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

// Self-test for the intent filter — remove after confirming all pass
function runIntentFilterTests(): void {
  const tests: Array<{ feedUrl: string; title: string; expected: boolean }> = [
    // Should FAIL (skip)
    { feedUrl: "https://www.reddit.com/r/forhire/new/.rss", title: "[FOR HIRE] I'll redesign & develop your website for a flat $750", expected: false },
    { feedUrl: "https://www.reddit.com/r/forhire/new/.rss", title: "[FOR HIRE] I'm a Web Developer - WordPress/WooCommerce/Shopify", expected: false },
    { feedUrl: "https://www.reddit.com/r/hiring/new/.rss", title: "[FOR HIRE] Senior React Developer available for hire", expected: false },
    { feedUrl: "https://www.reddit.com/r/webdev/new/.rss", title: "Show Showoff Saturday: Site Mirror Skill — Open-source CLI", expected: false },
    { feedUrl: "https://www.reddit.com/r/webdev/new/.rss", title: "I built a lightweight, zero dependency TS table/grid", expected: false },
    // Should PASS
    { feedUrl: "https://www.reddit.com/r/forhire/new/.rss", title: "[HIRING] React developer needed for SaaS startup", expected: true },
    { feedUrl: "https://www.reddit.com/r/forhire/new/.rss", title: "Coding Sprint [Hiring]", expected: true },
    { feedUrl: "https://www.reddit.com/r/hiring/new/.rss", title: "Looking for a frontend engineer, remote, $80-120/hr", expected: true },
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const result = passesIntentFilter(t.feedUrl, t.title);
    if (result === t.expected) {
      console.log(`[TEST PASS] "${t.title}"`);
      passed++;
    } else {
      console.error(`[TEST FAIL] Expected ${t.expected}, got ${result} — "${t.title}"`);
      failed++;
    }
  }
  console.log(`\nIntent filter tests: ${passed} passed, ${failed} failed`);
}

runIntentFilterTests();
