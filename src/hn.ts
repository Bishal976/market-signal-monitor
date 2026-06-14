// Last updated: 2026-06-14 — batch dedup writes (single seen_posts.json write per run)
import axios from "axios";
import { isSeen, markSeenBatch } from "./dedup";
import { sendJobAlert } from "./mailer";
import {
  analyzeAndDraft,
  canMakeAiCall,
  incrementAiCallCount,
  addCappedLead,
} from "./ai-filter";
import { matchesKeywords } from "./config";
import { JobPost } from "./types";

const NEW_STORIES_URL = "https://hacker-news.firebaseio.com/v0/newstories.json";
const ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const HN_ALGOLIA_HIRING_URL =
  "https://hn.algolia.com/api/v1/search?query=Ask+HN+Who+is+hiring&tags=story&hitsPerPage=1";
const TOP_N = 20;
const HIRING_THREAD_COMMENTS = 50;

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  time?: number;
  type?: string;
  text?: string;
  kids?: number[];
}

/** Strips HTML tags and collapses whitespace, for use as an email/AI-prompt snippet. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Scores a job through the AI pipeline and sends an alert, respecting the
 * per-cycle AI call cap. Returns true if the job was alerted on (AI match or fallback).
 */
async function processJob(job: JobPost): Promise<boolean> {
  if (!canMakeAiCall()) {
    console.log("[AI-FILTER] Cycle cap reached, skipping remaining matches.");
    addCappedLead({ title: job.title, url: job.url });
    return false;
  }
  incrementAiCallCount();

  try {
    const aiResult = await analyzeAndDraft(job);
    if (!aiResult) return false;
    await sendJobAlert(job, aiResult);
  } catch (err) {
    console.error("[AI-FILTER] error:", (err as Error).message);
    await sendJobAlert(job);
  }
  return true;
}

export async function runHnMonitor(): Promise<void> {
  const timestamp = new Date().toISOString();
  let matched = 0;
  const seenBatch: Array<{ id: string; source: string }> = [];

  try {
    // 1. Fetch the list of IDs
    const { data: ids } = await axios.get<number[]>(NEW_STORIES_URL, { timeout: 30000 });
    const topIds = ids.slice(0, TOP_N);
    const items: HnItem[] = [];

    // 2. Fetch items sequentially to prevent mobile hotspot connection dropping
    for (const id of topIds) {
      try {
        const res = await axios.get<HnItem>(ITEM_URL(id), { timeout: 30000 });
        if (res.data) items.push(res.data);
      } catch (itemErr) {
        console.warn(`[HN] Dropped connection on item ${id}, skipping to next...`);
        // We continue the loop instead of failing the whole batch
      }
    }

    // 3. Process and filter the successfully fetched items
    for (const item of items) {
      if (!item || item.type !== "story" || !item.title) continue;

      const text = `${item.title} ${item.text ?? ""}`;
      if (!matchesKeywords(text)) continue;
      if (isSeen("HN", String(item.id))) continue;
      seenBatch.push({ id: String(item.id), source: "HN" });

      const job: JobPost = {
        id: String(item.id),
        source: "HN",
        title: item.title,
        url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
        detail: item.text,
        posted: item.time ? new Date(item.time * 1000).toISOString() : undefined,
      };

      if (await processJob(job)) matched++;
    }

    markSeenBatch(seenBatch);
    console.log(`[${timestamp}] [HN] Run complete. New matches: ${matched}`);
  } catch (err) {
    console.error(`[${timestamp}] [HN] Error fetching root feed:`, (err as Error).message);
  }
}

/**
 * Finds the most recent "Ask HN: Who is hiring?" thread and scans its top-level
 * comments for keyword matches. Intended to run once daily (comments are always
 * hiring intent, so they skip the usual intent filter).
 */
// HN story IDs and hiring-thread comment IDs share the same numeric namespace,
// so hiring comments are deduped under a separate "HN_HIRING" source key to
// avoid false-positive collisions with regular "HN" story IDs.
export async function searchHNHiringThread(): Promise<void> {
  const timestamp = new Date().toISOString();
  const seenBatch: Array<{ id: string; source: string }> = [];

  try {
    const { data } = await axios.get(HN_ALGOLIA_HIRING_URL, { timeout: 30000 });
    const hit = data?.hits?.[0];
    if (!hit) {
      console.warn(`[${timestamp}] [HN-HIRING] No "Who is hiring" thread found.`);
      return;
    }

    const threadId = Number(hit.objectID);
    const { data: thread } = await axios.get<HnItem>(ITEM_URL(threadId), { timeout: 30000 });
    const commentIds = (thread.kids ?? []).slice(0, HIRING_THREAD_COMMENTS);

    console.log(`[${timestamp}] [HN-HIRING] Found thread ${threadId}, checking ${commentIds.length} comments`);

    for (const commentId of commentIds) {
      try {
        const { data: comment } = await axios.get<HnItem>(ITEM_URL(commentId), { timeout: 30000 });
        if (!comment || comment.type !== "comment" || !comment.text) continue;

        const plainText = stripHtml(comment.text);
        if (!matchesKeywords(plainText)) continue;
        if (isSeen("HN_HIRING", String(commentId))) continue;
        seenBatch.push({ id: String(commentId), source: "HN_HIRING" });

        const job: JobPost = {
          id: String(commentId),
          source: "HN",
          title: `HN Who's Hiring: ${plainText.slice(0, 80)}`,
          url: `https://news.ycombinator.com/item?id=${commentId}`,
          detail: plainText,
          posted: comment.time ? new Date(comment.time * 1000).toISOString() : undefined,
        };

        await processJob(job);
      } catch (itemErr) {
        console.warn(`[HN-HIRING] Dropped connection on comment ${commentId}, skipping to next...`);
      }
    }

    markSeenBatch(seenBatch);
  } catch (err) {
    console.error(`[${timestamp}] [HN-HIRING] Error:`, (err as Error).message);
  }
}
