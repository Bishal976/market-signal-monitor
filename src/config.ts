export const KEYWORDS = ["React", "Next.js", "frontend", "AI integration", "TypeScript"];

export const REDDIT_FEEDS = [
  "https://www.reddit.com/r/forhire/new/.rss",
  "https://www.reddit.com/r/hiring/new/.rss",
  "https://www.reddit.com/r/webdev/new/.rss",
];

export function matchesKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}
