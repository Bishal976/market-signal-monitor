// Last updated: 2026-06-16 — BUG1: age filter for stories + stale hiring-thread guard
import axios from "axios";
import { isSeen, markSeenBatch } from "./dedup";
import { sendJobAlert } from "./mailer";
import {
  analyzeAndDraft,
  canMakeAiCall,
  incrementAiCallCount,
  addCappedLead,
} from "./ai-filter";
import { checkKeywords } from "./config";
import { JobPost } from "./types";
import { recordScanned, recordKeywordMatch, recordIntentPass, recordAiScored, recordEmailSent } from "./stats";

const NEW_STORIES_URL = "https://hacker-news.firebaseio.com/v0/newstories.json";
const ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const TOP_N = 20;
const HIRING_THREAD_COMMENTS = 50;
const MAX_POST_AGE_DAYS = 30;

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
  recordAiScored();

  try {
    const aiResult = await analyzeAndDraft(job);
    if (!aiResult) return false;
    await sendJobAlert(job, aiResult);
    recordEmailSent();
  } catch (err) {
    console.error("[AI-FILTER] error:", (err as Error).message);
    await sendJobAlert(job);
    recordEmailSent();
  }
  return true;
}

export async function runHnMonitor(): Promise<void> {
  const timestamp = new Date().toISOString();
  let matched = 0;
  const seenBatch: Array<{ id: string; source: string }> = [];

  try {
    // 1. Fetch the list of IDs
    const { data: ids } = await axios.get<number[]>(NEW_STORIES_URL, { 
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobMonitorBot/1.0" }
    });
    const topIds = ids.slice(0, TOP_N);
    const items: HnItem[] = [];

    // 2. Fetch items sequentially to prevent mobile hotspot connection dropping
    for (const id of topIds) {
      try {
        const res = await axios.get<HnItem>(ITEM_URL(id), { 
          timeout: 30000,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobMonitorBot/1.0" }
        });
        if (res.data) items.push(res.data);
      } catch (itemErr) {
        console.warn(`[HN] Dropped connection on item ${id}, skipping to next...`);
        // We continue the loop instead of failing the whole batch
      }
    }

    // 3. Process and filter the successfully fetched items
    for (const item of items) {
      if (!item || item.type !== "story" || !item.title) continue;
      recordScanned();

      // Reject posts older than MAX_POST_AGE_DAYS
      if (item.time) {
        const ageMs = Date.now() - item.time * 1000;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_POST_AGE_DAYS) {
          console.log(`[HN] [AGE-FILTER] Skipped (${Math.floor(ageDays)}d old): ${item.title}`);
          continue;
        }
      }

      const text = `${item.title} ${item.text ?? ""}`;
      if (!checkKeywords(item.title, text)) continue;
      recordKeywordMatch();
      if (isSeen("HN", String(item.id))) continue;
      seenBatch.push({ id: String(item.id), source: "HN" });
      recordIntentPass(); // HN stories have no intent-filter stage

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
    // Constrain Algolia search to threads posted within the last 40 days,
    // so we never pick up a stale thread by relevance rank.
    const cutoff = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000);
    const algoliaUrl = `https://hn.algolia.com/api/v1/search?query=Ask+HN+Who+is+hiring&tags=story&hitsPerPage=1&numericFilters=created_at_i>${cutoff}`;

    const { data } = await axios.get(algoliaUrl, { 
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobMonitorBot/1.0" }
    });
    const hit = data?.hits?.[0];
    if (!hit) {
      console.warn(`[${timestamp}] [HN-HIRING] No "Who is hiring" thread found within the last 40 days.`);
      return;
    }

    const threadId = Number(hit.objectID);
    const { data: thread } = await axios.get<HnItem>(ITEM_URL(threadId), { 
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobMonitorBot/1.0" }
    });

    if (!thread || !thread.time) {
      console.log(`[HN-HIRING] No valid thread found within the last 40 days. Skipping.`);
      return;
    }
    const threadAgeDays = (Date.now() - thread.time * 1000) / (1000 * 60 * 60 * 24);
    if (threadAgeDays > 40) {
      console.log(`[HN-HIRING] Thread is ${Math.floor(threadAgeDays)}d old — skipping stale thread.`);
      return;
    }

    const commentIds = (thread.kids ?? []).slice(0, HIRING_THREAD_COMMENTS);
    console.log(`[${timestamp}] [HN-HIRING] Found thread ${threadId}, checking ${commentIds.length} comments`);

    for (const commentId of commentIds) {
      try {
        const { data: comment } = await axios.get<HnItem>(ITEM_URL(commentId), { 
          timeout: 30000,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobMonitorBot/1.0" }
        });
        if (!comment || comment.type !== "comment" || !comment.text) continue;
        recordScanned();

        const plainText = stripHtml(comment.text);
        if (!checkKeywords(plainText.slice(0, 80), plainText)) continue;
        recordKeywordMatch();
        if (isSeen("HN_HIRING", String(commentId))) continue;
        seenBatch.push({ id: String(commentId), source: "HN_HIRING" });
        // TEMP-DEBUG: Log intent pass
        console.log(`[TEMP-DEBUG] [HN-HIRING] Intent filter PASS: "${plainText.slice(0, 60)}"`);
        recordIntentPass(); // hiring-thread comments are always hiring intent

        const job: JobPost = {
          id: String(commentId),
          source: "HN",
          title: `HN Who's Hiring: ${plainText.slice(0, 80)}`,
          url: `https://news.ycombinator.com/item?id=${commentId}`,
          detail: plainText,
          posted: comment.time ? new Date(comment.time * 1000).toISOString() : undefined,
        };

        console.log(`[TEMP-DEBUG] [HN-HIRING] About to call processJob: "${plainText.slice(0, 50)}"`);
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
