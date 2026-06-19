export const KEYWORDS = [
  "React", "Next.js", "frontend", "AI integration", "TypeScript", 
  "javascript", "node", "full-stack", "web app", "developer", "engineer"
];

export const REDDIT_FEEDS = [
  "https://www.reddit.com/r/forhire/new/.rss",
  "https://www.reddit.com/r/hiring/new/.rss",
  "https://www.reddit.com/r/webdev/new/.rss",
];

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
