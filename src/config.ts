export const KEYWORDS = [
  "React", "Next.js", "frontend", "AI integration", "TypeScript",
  "javascript", "node", "full-stack", "web app", "developer", "engineer",
  "claude code", "cursor", "lovable", "v0.dev", "bolt",
  "vibe cod", "replit", "windsurf", "ai-built", "ai generated",
  "vibecoded", "vibe-coded"
];

/** Adding a new subreddit only requires editing this array — the fetch URL is built from it. */
export const SUBREDDITS = [
  "forhire",
  "hiring",
  "devjobs",
  "developers_hire",
  "DeveloperJobs",
  "freelance_forhire",
  "FullStackDevelopers",
  "hireaideveloper",
  "B2BForHire",
  "webdev",
  "Entrepreneur",
  "startups",
  "founder",
];

// Reddit's unauthenticated .json endpoint 403s from this host's IP (datacenter
// anti-bot block); the combined-subreddit .rss endpoint hits the same data
// without auth and isn't blocked, so we use that instead.
export const REDDIT_FEED_URL = `https://www.reddit.com/r/${SUBREDDITS.join("+")}/new/.rss`;

/** Set DEBUG_FILTERING=true to log every keyword check and the daily funnel summary. */
export const DEBUG_FILTERING = process.env.DEBUG_FILTERING === "true";

export function matchesKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Same matching logic as matchesKeywords, plus a [KEYWORD-CHECK] log line per
 * post when DEBUG_FILTERING is on, showing which keyword(s) hit (or none).
 */
export function checkKeywords(title: string, text: string): boolean {
  const lower = text.toLowerCase();
  const matched = KEYWORDS.filter((kw) => lower.includes(kw.toLowerCase()));

  if (DEBUG_FILTERING) {
    if (matched.length > 0) {
      console.log(`[KEYWORD-CHECK] PASSED (matched: ${matched.map((k) => `"${k}"`).join(", ")}): ${title}`);
    } else {
      console.log(`[KEYWORD-CHECK] FAILED (no keyword match): ${title}`);
    }
  }

  return matched.length > 0;
}
