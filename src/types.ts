export interface JobPost {
  id: string;
  source: "REDDIT" | "HN";
  title: string;
  url: string;
  detail?: string; // budget/rate, subreddit, etc.
  posted?: string;
}
