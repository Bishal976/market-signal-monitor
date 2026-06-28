// Last updated: 2026-06-22 — combined 13-subreddit feed via Reddit's multi-subreddit .rss endpoint
import axios from "axios";
import { fetchFeed, RssEntry } from "./rss";
import { isSeen, markSeenBatch } from "./dedup";
import { sendJobAlert } from "./mailer";
import { analyzeAndDraft, canMakeAiCall, incrementAiCallCount, addCappedLead } from "./ai-filter";
import { SUBREDDITS, REDDIT_FEED_URL, checkKeywords } from "./config";
import { JobPost } from "./types";
import { recordScanned, recordKeywordMatch, recordIntentPass, recordAiScored, recordEmailSent } from "./stats";

console.log(`Monitoring ${SUBREDDITS.length} subreddits: ${SUBREDDITS.join(", ")}`);

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

const WEBDEV_HELP_REQUEST_PATTERNS = [
  "need help", "help with", "help setting up", "help me",
  "how do i", "how to", "anyone know", "looking for guidance",
  "looking for help", "looking for tutorials", "looking for resources",
  "struggling with", "having trouble", "having a hard time",
  "can someone explain", "does anyone have", "what is the best way",
  "best practice", "recommendations for", "advice on", "guidance on",
  "newbie", "beginner", "just started", "not sure how",
  "unsure how", "unsure which",
];

// GEO BLOCK: posts with location restrictions are never remote freelance work
const GEO_BLOCK_PATTERNS: RegExp[] = [
  /\beu[\s-]only\b/i,
  /\beurope[\s-]only\b/i,
  /\beuropean[\s-]only\b/i,
  /\buk[\s-]only\b/i,
  /\buk[\s-]based\b/i,
  /united kingdom only/i,
  /\bus[\s-]only\b/i,
  /\busa[\s-]only\b/i,
  /united states only/i,
  /\bseattle\b/i,
  /new york only/i,
  /\bsf[\s-]only\b/i,
  /san francisco only/i,
  /must be based in/i,
  /must reside in/i,
  /must be located in/i,
  /\bwork authorization\b/i,
  /authorized to work in the us/i,
  /\bin-person\b/i,
  /\bonsite\b/i,
  /\bon-site\b/i,
  /\bhybrid\s+(work|role|position|schedule|arrangement)\b/i,
];

// EMPLOYMENT TYPE BLOCK: salary/benefits/equity-only signals mean it's not a freelance gig
const EMPLOYMENT_BLOCK_PATTERNS: RegExp[] = [
  /\$[1-9]\d{2,}k\b/i,
  /full[\s-]time employee/i,
  /\bw2\b/i,
  /benefits package/i,
  /health insurance/i,
  /equity[\s-]only/i,
  /sweat equity/i,
  /\bno salary\b/i,
  /revenue share only/i,
  /commission[\s-]only/i,
  /once it generates revenue/i,
  /when we raise funding/i,
];

/**
 * Hard pre-LLM filter. Returns false (discard) if the post contains any geo
 * restriction or full-time employment signal. These posts never consume Groq quota.
 */
function passesHardFilter(text: string, title: string): boolean {
  for (const pattern of GEO_BLOCK_PATTERNS) {
    if (pattern.test(text)) {
      console.log(`[HARD-FILTER] Geo block: "${title}"`);
      return false;
    }
  }
  for (const pattern of EMPLOYMENT_BLOCK_PATTERNS) {
    if (pattern.test(text)) {
      console.log(`[HARD-FILTER] Employment block: "${title}"`);
      return false;
    }
  }
  return true;
}

/**
 * Pre-filters posts by intent before they reach the AI, to avoid wasting
 * API calls on freelancer self-ads and community showcase threads.
 * Universal seller/showcase checks run first and apply to ALL subreddits.
 */
function passesIntentFilter(subreddit: string, title: string): boolean {
  const lower = title.toLowerCase();
  const sub = subreddit.toLowerCase();

  // Universal showcase/builder exclusions — apply to ALL subreddits
  if (WEBDEV_SHOWCASE_PATTERNS.some((pattern) => lower.includes(pattern))) {
    console.log(`[INTENT-FILTER] Skipped (showcase pattern): ${title}`);
    return false;
  }

  // Universal seller exclusions — apply to ALL subreddits
  if (FOR_HIRE_PATTERNS.some((p) => lower.includes(p))) {
    console.log(`[INTENT-FILTER] Skipped (seller): ${title}`);
    return false;
  }

  // r/forhire: require an explicit hiring signal in the title
  if (sub === "forhire") {
    if (lower.includes("[hiring]") || lower.startsWith("hiring")) return true;
    console.log(`[INTENT-FILTER] Skipped (r/forhire no hiring signal): ${title}`);
    return false;
  }

  // r/hiring: seller posts already caught above; remaining posts are buyer-side
  if (sub === "hiring") {
    return true;
  }

  // r/webdev: help-request posts have no buying intent — skip them
  if (sub === "webdev") {
    if (WEBDEV_HELP_REQUEST_PATTERNS.some((pattern) => lower.includes(pattern))) {
      console.log(`[INTENT-FILTER] Skipped (help request, no buying intent): ${title}`);
      return false;
    }
    return true;
  }

  // All other subreddits (devjobs, hireaideveloper, startups, etc.): no
  // dedicated rules yet, fall through to the universal checks above.
  return true;
}

const RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches the combined feed, retrying once after a 30s delay if rate-limited (429). */
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
  const seenBatch: Array<{ id: string; source: string }> = [];

  try {
    const entries = await fetchFeedWithRetry(REDDIT_FEED_URL);

    for (const entry of entries) {
      recordScanned();
      const text = `${entry.title} ${entry.description}`;
      if (!checkKeywords(entry.title, text)) continue;
      recordKeywordMatch();
      if (isSeen("REDDIT", entry.id)) continue;
      seenBatch.push({ id: entry.id, source: "REDDIT" });
      if (!passesIntentFilter(entry.subreddit ?? "", entry.title)) continue;
      recordIntentPass();

      // Hard filter — geo + employment type blocks before AI call
      if (!passesHardFilter(text, entry.title)) continue;

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
      recordAiScored();

      try {
        const aiResult = await analyzeAndDraft(job);
        if (!aiResult) continue;
        await sendJobAlert(job, aiResult);
        recordEmailSent();
      } catch (err) {
        console.error("[AI-FILTER] error:", (err as Error).message);
        await sendJobAlert(job);
        recordEmailSent();
      }
      matched++;
    }
  } catch (err) {
    console.error(`[${timestamp}] [REDDIT] Error fetching ${REDDIT_FEED_URL}:`, (err as Error).message);
  }

  markSeenBatch(seenBatch);
  console.log(`[${timestamp}] [REDDIT] Run complete. New matches: ${matched}`);
}

// Self-test for the intent filter — remove after confirming all pass
function runIntentFilterTests(): void {
  const tests: Array<{ subreddit: string; title: string; expected: boolean }> = [
    // Should FAIL (skip)
    { subreddit: "forhire", title: "[FOR HIRE] I'll redesign & develop your website for a flat $750", expected: false },
    { subreddit: "forhire", title: "[FOR HIRE] I'm a Web Developer - WordPress/WooCommerce/Shopify", expected: false },
    { subreddit: "hiring", title: "[FOR HIRE] Senior React Developer available for hire", expected: false },
    { subreddit: "webdev", title: "Show Showoff Saturday: Site Mirror Skill — Open-source CLI", expected: false },
    { subreddit: "webdev", title: "I built a lightweight, zero dependency TS table/grid", expected: false },
    // r/webdev help-requests — Should FAIL (skip)
    { subreddit: "webdev", title: "Need help in setting up Single-SPA + React + Vite + TypeScript microfrontend architecture", expected: false },
    { subreddit: "webdev", title: "How do I optimize React re-renders in a large dashboard?", expected: false },
    { subreddit: "webdev", title: "Looking for guidance on Next.js App Router migration", expected: false },
    { subreddit: "webdev", title: "Having trouble with TypeScript generics, can someone explain?", expected: false },
    // Should PASS
    { subreddit: "forhire", title: "[HIRING] React developer needed for SaaS startup", expected: true },
    { subreddit: "forhire", title: "Coding Sprint [Hiring]", expected: true },
    { subreddit: "hiring", title: "Looking for a frontend engineer, remote, $80-120/hr", expected: true },
    { subreddit: "webdev", title: "[Hiring] React developer needed for 2-week project", expected: true },
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const result = passesIntentFilter(t.subreddit, t.title);
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
