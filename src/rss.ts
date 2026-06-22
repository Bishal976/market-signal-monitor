import axios from "axios";
import * as cheerio from "cheerio";

export interface RssEntry {
  id: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  subreddit?: string;
}

/** Fetches and parses an RSS 2.0 (<item>) or Atom (<entry>) feed. */
export async function fetchFeed(url: string): Promise<RssEntry[]> {
  const res = await axios.get(url, {
    // Spoofing a standard mobile/desktop browser to clear the 429s on residential IPs
    headers: { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobMonitorBot/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    timeout: 30000,
  });
  const $ = cheerio.load(res.data, { xmlMode: true });

  const entries: RssEntry[] = [];

  // RSS 2.0
  $("item").each((_, el) => {
    const $el = $(el);
    const link = $el.find("link").first().text().trim();
    const guid = $el.find("guid").first().text().trim();
    entries.push({
      id: guid || link,
      title: $el.find("title").first().text().trim(),
      link,
      description: $el.find("description").first().text().trim(),
      pubDate: $el.find("pubDate").first().text().trim(),
    });
  });

  // Atom
  $("entry").each((_, el) => {
    const $el = $(el);
    const id = $el.find("id").first().text().trim();
    let link = $el.find("link").first().attr("href") ?? "";
    if (!link) link = id;
    entries.push({
      id: id || link,
      title: $el.find("title").first().text().trim(),
      link,
      description: $el.find("content").first().text().trim() || $el.find("summary").first().text().trim(),
      pubDate: $el.find("updated").first().text().trim() || $el.find("published").first().text().trim(),
      subreddit: $el.find("category").first().attr("term"),
    });
  });

  return entries;
}