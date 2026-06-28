// Last updated: 2026-06-29 — hardened system prompt + hard-filter rules applied pre-LLM
import axios from "axios";
import { JobPost } from "./types";
import { DEBUG_FILTERING } from "./config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const MAX_AI_CALLS_PER_CYCLE = 5;

export interface CappedLead {
  title: string;
  url: string;
}

let aiCallCount = 0;
let cappedLeads: CappedLead[] = [];

/** Resets the per-cycle AI call counter and capped-leads list. Call once at the start of each cron cycle. */
export function resetAiCycleState(): void {
  aiCallCount = 0;
  cappedLeads = [];
}

/** True if another AI call can still be made within this cycle's cap. */
export function canMakeAiCall(): boolean {
  return aiCallCount < MAX_AI_CALLS_PER_CYCLE;
}

export function incrementAiCallCount(): void {
  aiCallCount++;
}

export function addCappedLead(lead: CappedLead): void {
  cappedLeads.push(lead);
}

export function getCappedLeads(): CappedLead[] {
  return cappedLeads;
}

const SYSTEM_PROMPT = `You are a lead qualification agent screening posts for Bishal Kumar. You are NOT Bishal -- you are an assistant evaluating posts on his behalf. You must respond with ONLY a valid JSON object. No explanation, no markdown, no extra text.

PERSONA (for reference only): Bishal Kumar, Senior Frontend Developer, 3+ years experience in React, Next.js, TypeScript, Node.js, Supabase, and AI-integrated frontend tools. Builds fast production-quality frontends and small AI-powered SaaS tools for early-stage startups. Portfolio: bishal-portfolio-seven.vercel.app. Seeking REMOTE FREELANCE/CONTRACT work only.

INSTANT ZERO -- return {"score": 0, "reasoning": "<reason>", "draftedResponse": ""} immediately if ANY of these are true:

1. GEO RESTRICTION: post contains "US only", "USA only", "EU only", "Europe only", "UK only", "UK-based", "in-person", "onsite", "on-site", "hybrid", "must be based in", "must be located in", "must reside in", "work authorization", "authorized to work in the US", "Seattle", "New York only", "SF only", or "San Francisco only"

2. FULL-TIME EMPLOYMENT: post contains "W2", "full-time employee", "benefits package", or "health insurance", or annual salary ranges ($100k, $120k, $140k, $160k, $180k, $200k, or any six-figure annual salary)

3. NO UPFRONT PAYMENT: post mentions "equity only", "sweat equity", "no salary", "revenue share only", "commission only", "once it generates revenue", "when we raise funding", or any "pay you later after launch/funding" variant

4. NO BUDGET: no dollar amount, hourly rate, or explicit budget is mentioned anywhere in the post -- a post with tech requirements but zero budget figures scores 0

5. LOW BUDGET: fixed-price budget is under $300, or hourly rate is under $35/hr

6. SELF-PROMOTION: author is advertising their own services (they are the freelancer, not the client)

7. SHOWCASE OR COMMUNITY THREAD: post is "I built X", a project showcase, show-and-tell, weekly/monthly thread, or open-source release with no request for external paid help

8. BOT CONTEXT MISFIRE: the word "bot" appears but the post is NOT hiring someone to build a bot -- e.g., discussing bots, bot detection, using a bot tool, or bot moderation

9. VENTURE STUDIO: post is from a "venture studio" or "startup studio" with no named company, no verifiable product, and no company website

10. CO-FOUNDER SEARCH: post is seeking a co-founder, technical co-founder, or technical partner -- not a paid freelance or contract engagement

BUYING INTENT -- at least one must be present, or return score 0:
Strong: "hiring", "looking for developer", "need a developer", "need help with", "paid project", "contract", "freelance", "budget:", "rate:", "willing to pay", "MVP", "build this for me"
Medium: "who can help", "anyone available", "open to paying"

TECH FIT SCORE 1-10 (only after all instant-zero checks pass AND buying intent confirmed):
8-10: Perfect fit -- React/Next.js/TypeScript/Node.js/Supabase/AI frontend stack, explicitly remote, clear budget $500+ fixed or $50+/hr, early-stage startup or solo founder, freelance/contract
6-7: Good fit -- strong tech overlap, remote-friendly, budget $300+/$35+/hr, contract role
4-5: Partial fit -- some tech overlap but budget is lower range or stack is tangential
1-3: Weak fit -- generic dev request with little specificity
0: Any instant-zero rule triggered

DRAFTED RESPONSE (only if score >= 6):
Write a 2-3 paragraph outreach reply. Engineer tone, no fluff. Reference one specific detail from the post. End with portfolio link: bishal-portfolio-seven.vercel.app
If score < 6, return draftedResponse as empty string "".

Return format (always -- no other text outside this JSON):
{"score": <number>, "reasoning": "<string>", "draftedResponse": "<string>"}`;

export interface AiResult {
  score: number;
  reasoning: string;
  draftedResponse: string;
}

/**
 * Scores a post for fit and drafts an outreach message if it's a strong match.
 * Returns null if the score is below 6 (caller should skip alerting on it).
 */
export async function analyzeAndDraft(post: JobPost): Promise<AiResult | null> {
  const userMessage = [
    `Source: ${post.source}`,
    `Title: ${post.title}`,
    `URL: ${post.url}`,
    `Detail/snippet: ${post.detail ?? "N/A"}`,
    `Posted: ${post.posted ?? "N/A"}`,
  ].join("\n");

  const res = await axios.post(
    GROQ_URL,
    {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  const text: string | undefined = res.data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Unexpected response shape from Groq API");
  }

  let parsed: AiResult;
  try {
    const raw = text.trim();
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    parsed = JSON.parse(cleaned) as AiResult;

    if (
      typeof parsed.score !== "number" ||
      typeof parsed.reasoning !== "string" ||
      typeof parsed.draftedResponse !== "string"
    ) {
      throw new Error("Invalid response shape");
    }
  } catch {
    console.error(`[AI-FILTER] JSON parse failed, raw response: ${text.slice(0, 200)}`);
    // Throw (not return null) so the caller's catch block falls back to a
    // plain "[LEAD - NO AI]" email instead of silently dropping the lead.
    throw new Error("Groq response was not valid JSON");
  }

  // Gated at >=4 to surface near-misses without flooding logs with zero-score noise
  if (DEBUG_FILTERING && parsed.score >= 4) {
    console.log(
      `[SCORE-RESULT] Score: ${parsed.score} | Email threshold: 6 | Will send: ${parsed.score >= 6} | Title: "${post.title}"`
    );
  }

  if (parsed.score < 6) return null;
  return parsed;
}
